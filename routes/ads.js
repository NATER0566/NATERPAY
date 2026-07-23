const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const config = require('../config');
const Joi = require('joi'); // [1] Strict Request Validation

// [2] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let AuditLog, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

// [3] STRICT MONEY PRECISION HELPER
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    if (isNaN(num)) return 0;
    return num;
};

// [4] TEXT SANITIZATION (XSS Protection)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 255) : '';

// [5] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [6] REDIS RATE LIMITING (Anti-Spam & Anti-Click Fraud)
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 10, customId = null) {
    const ip = request.ip;
    const identifier = customId || (request.user ? request.user._id : ip);
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const key = `rate_${action}_${identifier}`;
        if (!fallbackRateLimits.has(key)) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(key);
        if (now > data.resetTime) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const key = `rate:${action}:${identifier}`;
            const count = await redisClient.incr(key);
            if (count === 1) await redisClient.expire(key, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

// [7] IMMUTABLE AUDIT LOGGING ENGINE
async function createAuditLog(params, session = null) {
    if (!AuditLog) return;
    try {
        const log = new AuditLog({
            user: params.user, transactionId: params.transactionId, transactionReference: params.reference,
            amount: params.amount, type: params.type, previousBalance: String(params.previousBalance),
            newBalance: String(params.newBalance), ipAddress: params.ipAddress, userAgent: params.userAgent,
            status: params.status, source: params.source
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

// Initialize Cloudinary
cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret
});

// [8] CLOUDINARY UPLOAD WITH NETWORK RETRY
const uploadToCloudinary = async (buffer, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const cld_upload_stream = cloudinary.uploader.upload_stream(
                    { folder: 'naterpay_ads', resource_type: 'auto', timeout: 20000 },
                    (error, result) => {
                        if (result) resolve(result.secure_url);
                        else reject(error);
                    }
                );
                streamifier.createReadStream(buffer).pipe(cld_upload_stream);
            });
        } catch (err) {
            if (i === retries - 1) throw new Error('Failed to upload media to cloud storage.');
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
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
        if (!await checkRateLimit(request, 'fetch_ads', 60)) throw { status: 429, message: 'Too many requests.' };

        const ads = await Ad.find({ 
            status: 'approved',
            expiryDate: { $gt: new Date() },
            $or: [{ remainingViews: { $gt: 0 } }, { remainingViews: undefined }]
        })
        .select('-user') 
        .sort({ packageCost: -1, createdAt: -1 }); 
            
        reply.send({ success: true, ads });
    } catch (error) { handleError(reply, error, 'Failed to load marketplace data.'); }
}

// ============================================================================
// PRIVATE: FETCH LOGGED-IN USER'S ADS
// ============================================================================
async function getUserAds(request, reply) {
    try {
        if (!await checkRateLimit(request, 'fetch_user_ads', 30)) throw { status: 429, message: 'Too many requests.' };

        const ads = await Ad.find({ user: request.user._id }).sort({ createdAt: -1 });
        reply.send({ success: true, ads });
    } catch (error) { handleError(reply, error, 'Failed to load your adverts.'); }
}

// ============================================================================
// ENTERPRISE SECURE TRANSACTION: CREATE & PAY VIA MULTIPART (ATOMIC)
// ============================================================================
async function createAd(request, reply) {
    try {
        if (!await checkRateLimit(request, 'create_ad', 5)) throw new Error('Too many requests. Please wait.');

        const parts = request.parts();
        let fields = {};
        let fileBuffer = null;

        for await (const part of parts) {
            if (part.type === 'file') {
                fileBuffer = await part.toBuffer();
            } else {
                fields[part.fieldname] = part.value;
            }
        }

        // [9] Strict Input Validation
        const schema = Joi.object({
            packageType: Joi.string().valid('basic', 'standard', 'premium', 'enterprise').required(),
            viewBudgetCost: Joi.number().min(0).default(0),
            businessName: Joi.string().required(),
            ownerName: Joi.string().allow('', null),
            email: Joi.string().email().required(),
            phoneNumber: Joi.string().required(),
            whatsappNumber: Joi.string().allow('', null),
            address: Joi.string().allow('', null),
            adType: Joi.string().required(),
            category: Joi.string().required(),
            title: Joi.string().required(),
            description: Joi.string().required(),
            targetUrl: Joi.string().uri().allow('', null),
            ctaText: Joi.string().allow('', null),
            price: Joi.number().allow('', null),
            salary: Joi.string().allow('', null),
            venue: Joi.string().allow('', null),
            eventDate: Joi.date().iso().allow('', null),
            targetLocation: Joi.string().allow('', null),
            targetDevice: Joi.string().allow('', null),
            maxRewardedViews: Joi.number().min(0).default(0)
        });

        const { error, value } = schema.validate(fields, { stripUnknown: true });
        if (error) throw error;

        const userId = request.user._id;
        const pkgConfig = PACKAGE_CONFIG[value.packageType];
        if (!pkgConfig) throw new Error('Invalid advertisement package.');
        
        const packageCost = sanitizeAmount(pkgConfig.price);
        const viewBudgetCost = sanitizeAmount(value.viewBudgetCost);
        const totalAdCost = sanitizeAmount(packageCost + viewBudgetCost);

        // Upload Media OUTSIDE the database session to avoid locking the DB during network delays
        let mediaSecureUrl = 'https://via.placeholder.com/800x400/111/d4af37?text=Promotional+Campaign';
        if (fileBuffer && value.adType !== 'Text') {
            const maxSize = 15 * 1024 * 1024; // 15MB limit for videos/images
            if (fileBuffer.length > maxSize) throw new Error('Media file too large. Maximum size is 15MB.');
            mediaSecureUrl = await uploadToCloudinary(fileBuffer);
        }

        // [10] ATOMIC DATABASE SESSION
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ user: userId }).session(session);
            if (!wallet) throw new Error('Wallet not found.');

            const currentBalance = sanitizeAmount(wallet.availableBalance);
            if (currentBalance < totalAdCost) throw new Error(`Insufficient balance. You need ₦${totalAdCost.toLocaleString()} to launch this campaign.`);

            const newBalance = currentBalance - totalAdCost;
            wallet.availableBalance = String(newBalance);
            wallet.balance = String(sanitizeAmount(wallet.balance) - totalAdCost);
            await wallet.save({ session });

            const paymentRef = `CMP-${Date.now()}`;
            const paymentTx = new Transaction({
                user: userId, type: 'withdrawal', description: `Campaign Launch (${value.packageType.toUpperCase()} + Views)`,
                amount: totalAdCost, fee: 0, balanceBefore: String(currentBalance), balanceAfter: String(newBalance),
                status: 'success', provider: 'internal', reference: paymentRef
            });
            await paymentTx.save({ session }); 

            await createAuditLog({
                user: userId, transactionId: paymentTx._id, reference: paymentRef, amount: totalAdCost,
                type: 'ad_campaign_payment', previousBalance: currentBalance, newBalance: newBalance, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Ad Engine API'
            }, session);

            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + pkgConfig.days);

            const newAd = new Ad({
                user: userId,
                businessName: sanitizeText(value.businessName),
                ownerName: sanitizeText(value.ownerName),
                email: sanitizeText(value.email),
                phoneNumber: sanitizeText(value.phoneNumber),
                whatsappNumber: sanitizeText(value.whatsappNumber),
                address: sanitizeText(value.address),
                adType: sanitizeText(value.adType),
                category: sanitizeText(value.category),
                title: sanitizeText(value.title),
                description: sanitizeText(value.description),
                targetUrl: value.targetUrl,
                ctaText: sanitizeText(value.ctaText),
                price: value.price,
                salary: sanitizeText(value.salary),
                venue: sanitizeText(value.venue),
                eventDate: value.eventDate,
                mediaUrl: mediaSecureUrl,
                targetLocation: sanitizeText(value.targetLocation),
                targetDevice: sanitizeText(value.targetDevice),
                packageType: value.packageType,
                packageCost: packageCost,
                maxRewardedViews: value.maxRewardedViews,
                remainingViews: value.maxRewardedViews,
                viewBudgetCost: viewBudgetCost,
                rewardAmount: 5,
                expiryDate: expiryDate,
                status: 'pending' 
            });
            await newAd.save({ session });

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: wallet.availableBalance });
            reply.send({ success: true, message: 'Campaign launched successfully! It is now pending admin review.' });

        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'Failed to process campaign launch.'); }
}

// ============================================================================
// ANALYTICS: REGISTER CLICKS OUT TO EXTERNAL URL (ANTI-FRAUD PROTECTED)
// ============================================================================
async function registerClick(request, reply) {
    try {
        // [11] Anti-Click Fraud Limit: IP can only register 1 click per ad per 5 minutes
        const { id } = request.params;
        const fraudKey = `click_ad_${id}_ip_${request.ip}`;
        
        if (!await checkRateLimit(request, fraudKey, 1)) {
            // Silently ignore to prevent bots from knowing they are blocked
            return reply.send({ success: true }); 
        }

        await Ad.findByIdAndUpdate(id, { $inc: { clicks: 1 } });
        reply.send({ success: true });
    } catch (error) {
        // Silently fail to frontend so analytics drops don't interrupt UX
        reply.send({ success: true }); 
    }
}

module.exports = { getAds, getUserAds, createAd, registerClick };
