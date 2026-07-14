const Advertisement = require('../models/Advertisement');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

const PACKAGE_PRICES = {
    basic: 1000,
    standard: 3500,
    premium: 10000
};

// ============================================================================
// PUBLIC: FETCH APPROVED ADS FOR THE MARKETPLACE
// ============================================================================
async function getAds(request, reply) {
    try {
        // Only fetch ads that the Admin has approved
        const ads = await Advertisement.find({ status: 'approved' })
            .select('-ownerId') // Hide owner ID for security
            .sort({ featured: -1, createdAt: -1 }); // Featured ads appear first
            
        reply.send({ success: true, ads });
    } catch (error) {
        console.error('Fetch Ads Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to load marketplace data.' });
    }
}

// ============================================================================
// PRIVATE: FETCH LOGGED-IN USER'S ADS
// ============================================================================
async function getUserAds(request, reply) {
    try {
        const ads = await Advertisement.find({ ownerId: request.user._id }).sort({ createdAt: -1 });
        reply.send({ success: true, ads });
    } catch (error) {
        console.error('Fetch User Ads Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to load your adverts.' });
    }
}

// ============================================================================
// SECURE TRANSACTION: CREATE & PAY FOR ADVERT
// ============================================================================
async function createAd(request, reply) {
    try {
        const { 
            businessName, title, category, location, description, 
            phoneNumber, whatsappNumber, website, packageType, imageUrl 
        } = request.body;

        const userId = request.user._id;

        // 1. Validate Package and Pricing
        if (!PACKAGE_PRICES[packageType]) {
            return reply.status(400).send({ success: false, message: 'Invalid advertisement package selected.' });
        }
        
        const adCost = PACKAGE_PRICES[packageType];

        // 2. Secure Wallet Check
        const wallet = await Wallet.findOne({ user: userId });
        if (!wallet) {
            return reply.status(404).send({ success: false, message: 'Wallet not found.' });
        }

        const currentBalance = Number(parseFloat(wallet.availableBalance?.toString() || '0').toFixed(2));
        
        if (currentBalance < adCost) {
            return reply.status(400).send({ 
                success: false, 
                message: `Insufficient balance. You need ₦${adCost.toLocaleString()} for the ${packageType.toUpperCase()} package.` 
            });
        }

        // 3. Deduct Funds Securely
        const newBalance = currentBalance - adCost;
        const newLedger = Number(parseFloat(wallet.balance?.toString() || '0').toFixed(2)) - adCost;

        // Create the Audit Trail / Transaction Log FIRST
        const paymentTx = new Transaction({
            user: userId,
            type: 'service_payment',
            description: `Advert Placement (${packageType.toUpperCase()} Package)`,
            amount: adCost,
            fee: 0,
            balanceBefore: String(currentBalance),
            balanceAfter: String(newBalance),
            status: 'success',
            provider: 'internal',
            reference: `ADV-${Date.now()}`
        });

        await paymentTx.save(); // Fails safely here if there's an error

        // Update Wallet
        wallet.availableBalance = String(newBalance);
        wallet.balance = String(newLedger);
        await wallet.save();

        // 4. Create the Advert inside the database
        const newAd = new Advertisement({
            ownerId: userId,
            businessName,
            title,
            category,
            location,
            description,
            phoneNumber,
            whatsappNumber,
            website,
            package: packageType,
            imageUrl,
            status: 'pending', // Awaiting Admin Approval
            featured: packageType === 'premium' // Auto-feature if premium
        });

        await newAd.save();

        // Notify user balance update via Socket.io
        if (request.server && request.server.io) {
            request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: wallet.availableBalance });
        }

        reply.send({ success: true, message: 'Advert paid successfully and is now pending review.' });

    } catch (error) {
        console.error('Create Ad Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process advert payment.' });
    }
}

// ============================================================================
// ANALYTICS: REGISTER CLICKS
// ============================================================================
async function registerClick(request, reply) {
    try {
        const { id } = request.params;
        await Advertisement.findByIdAndUpdate(id, { $inc: { clicks: 1 } });
        reply.send({ success: true });
    } catch (error) {
        reply.status(500).send({ success: false });
    }
}

module.exports = {
    getAds,
    getUserAds,
    createAd,
    registerClick
};
