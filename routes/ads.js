const Ad = require('../models/Ad');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const config = require('../config');

// Initialize Cloudinary
cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret
});

// Helper to stream files directly to Cloudinary (No Base64!)
const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const cld_upload_stream = cloudinary.uploader.upload_stream(
      { folder: 'naterpay_ads', resource_type: 'auto' }, // 'auto' accepts images, videos, and PDFs
      (error, result) => {
        if (result) resolve(result.secure_url);
        else reject(error);
      }
    );
    streamifier.createReadStream(buffer).pipe(cld_upload_stream);
  });
};

const PACKAGE_CONFIG = {
    basic: { price: 1000, days: 20 },
    standard: { price: 3500, days: 40 },
    premium: { price: 10000, days: 90 },
    enterprise: { price: 25000, days: 180 }
};

// ============================================================================
// PUBLIC: FETCH APPROVED ADS FOR MARKETPLACE
// ============================================================================
async function getAds(request, reply) {
    try {
        // Fetch ads that are approved and haven't expired or run out of views
        const ads = await Ad.find({ 
            status: 'approved',
            expiryDate: { $gt: new Date() },
            $or: [{ remainingViews: { $gt: 0 } }, { remainingViews: undefined }]
        })
        .select('-user') // Hide user ID for security
        .sort({ packageCost: -1, createdAt: -1 }); // Sort Enterprise/Premium first
            
        reply.send({ success: true, ads });
    } catch (error) {
        console.error('[ADS FETCH ERROR]:', error);
        reply.status(500).send({ success: false, message: 'Failed to load marketplace data.' });
    }
}

// ============================================================================
// PRIVATE: FETCH LOGGED-IN USER'S ADS
// ============================================================================
async function getUserAds(request, reply) {
    try {
        const ads = await Ad.find({ user: request.user._id }).sort({ createdAt: -1 });
        reply.send({ success: true, ads });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to load your adverts.' });
    }
}

// ============================================================================
// ENTERPRISE SECURE TRANSACTION: CREATE & PAY VIA MULTIPART
// ============================================================================
async function createAd(request, reply) {
    try {
        const parts = request.parts();
        let fields = {};
        let fileBuffer = null;

        // Extract fields and file streams safely
        for await (const part of parts) {
            if (part.type === 'file') {
                fileBuffer = await part.toBuffer();
            } else {
                fields[part.fieldname] = part.value;
            }
        }

        const userId = request.user._id;

        // 1. Verify Package & Budgets
        const pkgConfig = PACKAGE_CONFIG[fields.packageType];
        if (!pkgConfig) return reply.status(400).send({ success: false, message: 'Invalid advertisement package.' });
        
        const packageCost = pkgConfig.price;
        const viewBudgetCost = parseInt(fields.viewBudgetCost) || 0;
        const totalAdCost = packageCost + viewBudgetCost; // Enterprise CPRV Calculation

        // 2. Secure Wallet Check
        const wallet = await Wallet.findOne({ user: userId });
        if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found.' });

        const currentBalance = Number(parseFloat(wallet.availableBalance?.toString() || '0').toFixed(2));
        
        if (currentBalance < totalAdCost) {
            return reply.status(400).send({ 
                success: false, 
                message: `Insufficient balance. You need ₦${totalAdCost.toLocaleString()} to launch this campaign.` 
            });
        }

        // 3. Upload Media to Cloudinary (If provided)
        let mediaSecureUrl = 'https://via.placeholder.com/800x400/111/d4af37?text=Promotional+Campaign';
        if (fileBuffer && fields.adType !== 'Text') {
            mediaSecureUrl = await uploadToCloudinary(fileBuffer);
        }

        // 4. DEDUCT FUNDS SECURELY
        const newBalance = currentBalance - totalAdCost;
        const newLedger = Number(parseFloat(wallet.balance?.toString() || '0').toFixed(2)) - totalAdCost;

        wallet.availableBalance = String(newBalance);
        wallet.balance = String(newLedger);
        await wallet.save();

        // 5. SAFELY LOG TRANSACTION
        try {
            const paymentTx = new Transaction({
                user: userId,
                type: 'withdrawal', 
                description: `Campaign Launch (${fields.packageType.toUpperCase()} + Views)`,
                amount: totalAdCost,
                fee: 0,
                balanceBefore: String(currentBalance),
                balanceAfter: String(newBalance),
                status: 'success',
                provider: 'internal',
                reference: `CMP-${Date.now()}`
            });
            await paymentTx.save(); 
        } catch (txError) {
            console.warn("Wallet deducted for Campaign, but log failed:", txError);
        }

        // 6. CALCULATE EXACT EXPIRY DATE
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + pkgConfig.days);

        // 7. CREATE DATABASE RECORD
        const newAd = new Ad({
            user: userId,
            businessName: fields.businessName,
            ownerName: fields.ownerName,
            email: fields.email,
            phoneNumber: fields.phoneNumber,
            whatsappNumber: fields.whatsappNumber,
            address: fields.address,
            
            adType: fields.adType,
            category: fields.category,
            title: fields.title,
            description: fields.description,
            targetUrl: fields.targetUrl,
            ctaText: fields.ctaText,
            
            // Dynamic Data
            price: fields.price ? Number(fields.price) : undefined,
            salary: fields.salary,
            venue: fields.venue,
            eventDate: fields.eventDate ? new Date(fields.eventDate) : undefined,
            
            mediaUrl: mediaSecureUrl,
            targetLocation: fields.targetLocation,
            targetDevice: fields.targetDevice,
            
            packageType: fields.packageType,
            packageCost: packageCost,
            maxRewardedViews: parseInt(fields.maxRewardedViews) || 0,
            remainingViews: parseInt(fields.maxRewardedViews) || 0,
            viewBudgetCost: viewBudgetCost,
            rewardAmount: 5,
            
            expiryDate: expiryDate,
            status: 'pending' // Awaiting Admin Approval
        });

        await newAd.save();

        if (request.server && request.server.io) {
            request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: wallet.availableBalance });
        }

        reply.send({ success: true, message: 'Campaign launched successfully! It is now pending admin review.' });

    } catch (error) {
        console.error('[CAMPAIGN CREATION ERROR]:', error);
        reply.status(500).send({ success: false, message: 'Failed to process campaign launch.' });
    }
}

// ============================================================================
// ANALYTICS: REGISTER CLICKS OUT TO EXTERNAL URL
// ============================================================================
async function registerClick(request, reply) {
    try {
        const { id } = request.params;
        await Ad.findByIdAndUpdate(id, { $inc: { clicks: 1 } });
        reply.send({ success: true });
    } catch (error) {
        reply.status(500).send({ success: false });
    }
}

// Note: The actual Rewarded Views countdown logic is executed safely in 
// routes/tasks.js during the claimAd function.

module.exports = { getAds, getUserAds, createAd, registerClick };
