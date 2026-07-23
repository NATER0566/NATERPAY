const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
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

// [4] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [5] REDIS RATE LIMITING (Prevents spam-clicking)
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 5) {
    const ip = request.ip;
    const userId = request.user ? request.user._id : 'anon';
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const userKey = `rate_${action}_user_${userId}`;
        if (!fallbackRateLimits.has(userKey)) {
            fallbackRateLimits.set(userKey, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(userKey);
        if (now > data.resetTime) {
            fallbackRateLimits.set(userKey, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const userKey = `rate:${action}:user:${userId}`;
            const count = await redisClient.incr(userKey);
            if (count === 1) await redisClient.expire(userKey, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

// [6] IMMUTABLE AUDIT LOGGING ENGINE
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

/* ============================================================================
   PROFILE COMPLETION REWARD ENGINE (ATOMIC SESSION & AUDIT)
============================================================================ */
async function claimProfileReward(request, reply) {
    if (!await checkRateLimit(request, 'claim_profile', 3)) return reply.status(429).send({ success: false, message: 'Too many requests.' });

    const userId = request.user._id;
    const idempotencyKey = `profile_reward_${userId}`; 

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Atomic Lock 1: Check existing claim inside session
        const existingClaim = await Transaction.findOne({ idempotencyKey }).session(session);
        if (existingClaim) {
            await session.abortTransaction(); session.endSession();
            return reply.status(400).send({ success: false, message: 'You have already claimed your profile completion reward.' });
        }

        const User = mongoose.models.User || mongoose.model('User');
        const user = await User.findById(userId).session(session);

        const isKycApproved = user && (user.kycLevel >= 3);
        if (!isKycApproved) {
            await session.abortTransaction(); session.endSession();
            return reply.status(400).send({ success: false, message: 'Please complete all 3 levels of KYC Identity & Address Verification to unlock this reward.' });
        }

        const wallet = await Wallet.findOne({ user: userId }).session(session);
        if (!wallet) throw new Error('Wallet not found.');

        const rewardAmt = 50;
        const currentAvail = sanitizeAmount(wallet.availableBalance);
        const currentTotal = sanitizeAmount(wallet.balance);
        const newAvail = currentAvail + rewardAmt;

        wallet.availableBalance = String(newAvail);
        wallet.balance = String(currentTotal + rewardAmt);
        await wallet.save({ session });

        const tx = new Transaction({
            user: userId, type: 'task_reward', description: 'KYC Verification Reward',
            amount: rewardAmt, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
            status: 'success', provider: 'system', idempotencyKey 
        });
        await tx.save({ session });

        await createAuditLog({
            user: userId, transactionId: tx._id, reference: `KYC-REW-${Date.now()}`, amount: rewardAmt,
            type: 'task_reward', previousBalance: currentAvail, newBalance: newAvail, 
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Profile Reward API'
        }, session);

        await session.commitTransaction();
        session.endSession();

        if (request.server && request.server.io) request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });

        return reply.send({ success: true, message: '₦50 Profile Reward credited successfully!' });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(reply, error, 'Internal server error processing reward.');
    }
}

/* ============================================================================
   STRICT ONCE-IN-A-LIFETIME CLICK & EARN AD ENGINE (ATOMIC SESSION)
============================================================================ */
async function claimAd(request, reply) {
    try {
        if (!await checkRateLimit(request, 'claim_ad', 10)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({ adId: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { adId } = value;
        const userId = request.user._id;
        const lifetimeSecurityKey = `task_ad_${adId}_${userId}`;

        const existingClaim = await Transaction.findOne({ idempotencyKey: lifetimeSecurityKey });
        if (existingClaim) return reply.status(400).send({ success: false, message: 'already claimed' });

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        const dailyClaimsCount = await Transaction.countDocuments({
            user: userId, type: 'task_reward', createdAt: { $gte: todayStart }, description: { $regex: /^Ad Reward:/ } 
        });

        if (dailyClaimsCount >= 20) {
            return reply.status(400).send({ success: false, message: 'Daily limit reached! You have completed your 20 rewarded ads for today. Check back tomorrow.' });
        }

        const AdModel = mongoose.models.Ad;
        let rewardAmount = 5; 
        let adName = `Sponsored Campaign #${adId}`;

        if (AdModel) {
            const adData = await AdModel.findOneAndUpdate(
                { _id: adId, remainingViews: { $gt: 0 } },
                { $inc: { impressions: 1, remainingViews: -1 } },
                { new: true }
            );

            if (!adData) {
                const exists = await AdModel.findById(adId);
                if (!exists) return reply.status(404).send({ success: false, message: 'Ad campaign has expired or does not exist.' });
                return reply.status(400).send({ success: false, message: 'limit reached' });
            }

            rewardAmount = sanitizeAmount(adData.rewardAmount || 5);
            // XSS Protection on dynamic Ad Title insertion
            const safeAdTitle = adData.title ? String(adData.title).replace(/[<>]/g, '').trim().substring(0, 50) : 'Sponsored Link';
            adName = `Ad Reward: ${safeAdTitle}`;
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ user: userId }).session(session);
            if (!wallet) throw new Error('Wallet not found.');

            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentTotal = sanitizeAmount(wallet.balance);
            const newAvail = currentAvail + rewardAmount;

            wallet.availableBalance = String(newAvail);
            wallet.balance = String(currentTotal + rewardAmount);
            await wallet.save({ session });

            const tx = new Transaction({
                user: userId, type: 'task_reward', description: adName,
                amount: rewardAmount, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
                status: 'success', provider: 'system', metadata: { adId }, idempotencyKey: lifetimeSecurityKey 
            });
            await tx.save({ session });

            await createAuditLog({
                user: userId, transactionId: tx._id, reference: `AD-REW-${Date.now()}`, amount: rewardAmount,
                type: 'task_reward', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Ad Claim API'
            }, session);

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });

            return reply.send({ success: true, message: `₦${rewardAmount} credited successfully.` });
        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) {
        if (error.code === 11000) return reply.status(400).send({ success: false, message: 'already claimed' });
        handleError(reply, error, 'Internal server error processing reward.');
    }
}

module.exports = { claimAd, claimProfileReward };
