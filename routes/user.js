const mongoose = require('mongoose');
const User = require('../models/User'); 
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const { sanitizeUser } = require('../utils/auth');
const bcrypt = require('bcryptjs'); 
const Joi = require('joi'); // [1] Strict Request Validation

// [2] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

// Dynamic Imports
let AuditLog, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

// [3] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [4] STRICT MONEY PRECISION HELPER
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    if (isNaN(num)) return 0;
    return num;
};

// [5] TEXT SANITIZATION (XSS Protection)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 255) : '';

/* =========================================================================
   [6] REDIS / DISTRIBUTED RATE LIMITING ENGINE
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 10) {
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

/* =========================================================================
   [7] IMMUTABLE AUDIT LOGGING ENGINE
========================================================================= */
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

/* =========================================================================
   [8] GLOBAL PIN SECURITY ENGINE (WITH 3-ATTEMPT LOCKOUT)
========================================================================= */
async function verifyAndHandlePin(user, wallet, providedPin) {
    if (user.pinLockUntil && user.pinLockUntil > new Date()) {
        throw new Error(`Security Lock: PIN blocked until ${user.pinLockUntil.toLocaleTimeString()}.`);
    }

    let isPinValid = false; 
    if (typeof wallet.verifyPin === 'function') { 
        isPinValid = await wallet.verifyPin(String(providedPin)); 
    } else if (wallet.pin) { 
        isPinValid = await bcrypt.compare(String(providedPin), wallet.pin); 
    } else { 
        throw new Error('Security Alert: Transaction PIN not configured.'); 
    } 
    
    if (!isPinValid) { 
        const failedAttempts = (user.failedPinAttempts || 0) + 1; 
        let updateDoc = { failedPinAttempts: failedAttempts }; 
        if (failedAttempts >= 3) { 
            updateDoc.pinLockUntil = new Date(Date.now() + 15 * 60000); 
            updateDoc.failedPinAttempts = 0; 
        } 
        await User.updateOne({ _id: user._id }, { $set: updateDoc }); 
        throw new Error(failedAttempts >= 3 ? 'SECURITY ALERT: Maximum attempts reached. Account locked for 15 minutes.' : `Incorrect PIN. ${3 - failedAttempts} attempts remaining.`); 
    } 
    
    if (user.failedPinAttempts > 0) { 
        await User.updateOne({ _id: user._id }, { $set: { failedPinAttempts: 0, pinLockUntil: null } }); 
    } 
    return true; 
}

/* ============================================================================
   GET DASHBOARD DATA (LIFETIME MATH FIXED FOR PRECISION)
============================================================================ */
async function getDashboardData(request, reply) {
    try {
        const user = await User.findById(request.user._id);
        const wallet = await Wallet.findOne({ user: user._id });
        const recentTransactions = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(15);
        const kyc = await KYC.findOne({ user: user._id });
        
        const allTransactions = await Transaction.find({ user: user._id, status: 'success' });
        const totalLogs = allTransactions.length;
        
        let totalSpent = 0;
        let totalCommission = 0;

        allTransactions.forEach(tx => {
            const amount = sanitizeAmount(tx.amount?.toString());
            const txType = (tx.type || '').toLowerCase();
            const desc = (tx.description || '').toLowerCase();
            
            // 1. CALCULATE TRUE OUTFLOW (SPENT)
            const isCredit = ['funding', 'referral_bonus', 'cashback', 'refund', 'task_reward'].includes(txType) || 
                             (tx.flow === 'in') || desc.includes('admin credit') ||
                             (txType === 'transfer' && (desc.includes('received') || desc.includes('from')));
                             
            if (!isCredit) {
                const feeAmt = sanitizeAmount(tx.fee?.toString());
                const totalDed = tx.totalDeduction ? sanitizeAmount(tx.totalDeduction.toString()) : sanitizeAmount(amount + feeAmt);
                totalSpent += totalDed;
            }

            // 2. CALCULATE TRUE LIFETIME COMMISSIONS & CASHBACK
            if (['cashback', 'task_reward', 'reward', 'referral_bonus', 'commission'].includes(txType) || 
                desc.includes('commission') || desc.includes('cashback') || desc.includes('earned') || desc.includes('bonus')) {
                totalCommission += amount;
            }
        });
        
        reply.send({
            success: true,
            userFullName: user.name,
            userEmail: user.email,
            userPhone: user.phoneNumber,
            userRole: user.role,
            kycLevel: kyc ? kyc.currentLevel : 0,
            isSecured: user.isSecured,
            balance: wallet ? wallet.availableBalance.toString() : '0',
            totalLogs,
            totalSpent: sanitizeAmount(totalSpent).toString(),
            totalCommission: sanitizeAmount(totalCommission).toString(),
            referralCount: user.referralCount || 0,
            referralBonus: user.referralBonus ? sanitizeAmount(user.referralBonus.toString()).toString() : '0',
            cumulativeSpend: sanitizeAmount(user.cumulativeSpend).toString(),
            referralBonusPaid: user.referralBonusPaid || false,
            hiddenWidgets: user.hiddenWidgets || [],
            referralCode: user.referralCode,
            createdAt: user.createdAt,
            
            recentTransactions: recentTransactions.map(tx => {
                const baseAmt = sanitizeAmount(tx.amount?.toString());
                const feeAmt = sanitizeAmount(tx.fee?.toString());
                const totalDed = tx.totalDeduction ? sanitizeAmount(tx.totalDeduction.toString()) : sanitizeAmount(baseAmt + feeAmt);
                const txType = (tx.type || '').toLowerCase();
                const desc = (tx.description || '').toLowerCase();
                const isCredit = ['funding', 'referral_bonus', 'cashback', 'refund', 'task_reward'].includes(txType) || 
                                 (tx.flow === 'in') || desc.includes('admin credit') ||
                                 (txType === 'transfer' && (desc.includes('received') || desc.includes('from')));

                return {
                    _id: tx._id, date: tx.createdAt, type: tx.type, description: tx.description,
                    amount: baseAmt.toString(), fee: feeAmt.toString(), totalDeduction: totalDed.toString(),
                    isCredit: isCredit, status: tx.status
                };
            })
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch dashboard data'); }
}

async function updatePreferences(request, reply) {
    try {
        const schema = Joi.object({ action: Joi.string().valid('hide', 'show').required(), target: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (value.action === 'hide') { 
            if (!request.user.hiddenWidgets.includes(value.target)) request.user.hiddenWidgets.push(value.target); 
        } else { 
            request.user.hiddenWidgets = request.user.hiddenWidgets.filter(w => w !== value.target); 
        }
        await request.user.save();
        reply.send({ success: true, message: 'Preferences updated' });
    } catch (error) { handleError(reply, error, 'Failed to update preferences'); }
}

async function updateProfile(request, reply) {
    try {
        if (!await checkRateLimit(request, 'profile_update', 5)) throw new Error('Too many updates. Please wait.');

        const schema = Joi.object({ name: Joi.string().optional(), phoneNumber: Joi.string().optional() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (value.name) request.user.name = sanitizeText(value.name);
        if (value.phoneNumber) request.user.phoneNumber = sanitizeText(value.phoneNumber);
        await request.user.save();
        
        reply.send({ success: true, message: 'Profile updated', user: sanitizeUser(request.user) });
    } catch (error) { handleError(reply, error, 'Failed to update profile'); }
}

async function getReferralTree(request, reply) {
    try {
        if (!await checkRateLimit(request, 'referral_tree', 30)) throw new Error('Too many requests.');

        const user = await User.findById(request.user._id);
        if (!user || !user.referralCode) return reply.send({ success: true, referrals: [] });
        const referrals = await User.find({ 
            $or: [ { referredBy: user.referralCode }, { referredBy: { $regex: new RegExp(`^${user.referralCode}$`, 'i') } }, { referredBy: user._id.toString() } ] 
        }).select('name createdAt email cumulativeSpend referralBonusPaid').sort({ createdAt: -1 });
        reply.send({ success: true, referrals });
    } catch (error) { handleError(reply, error, 'Failed to fetch network tree'); }
}

/* ============================================================================
   UPGRADE USER (ATOMIC LEDGER + AUDIT FIX)
============================================================================ */
async function upgradeUser(request, reply) {
    try {
        // [1] Input Validation
        const schema = Joi.object({ role: Joi.string().valid('agent', 'reseller', 'vip').required(), amount: Joi.number().required(), pin: Joi.string().length(4).required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'upgrade', 5)) throw new Error('Too many attempts. Try again later.');

        const userId = request.user._id;
        const { role, amount, pin } = value;

        // [2] Validate Pricing
        let expectedAmount = 2000;
        if (role === 'reseller') expectedAmount = 5000;
        if (role === 'vip') expectedAmount = 15000;

        if (sanitizeAmount(amount) !== expectedAmount) throw new Error('System alert: Upgrade fee amount mismatch detected.');

        // Prevent Double Upgrades
        if (request.user.role === 'vip' || (request.user.role === 'reseller' && role === 'reseller')) {
            throw new Error(`You are already on the ${request.user.role.toUpperCase()} tier or higher!`);
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // Fetch User & Wallet specifically for PIN verification
            const user = await User.findById(userId).session(session);
            const walletCheck = await Wallet.findOne({ user: userId }).select('+pin').session(session);
            if (!walletCheck) throw new Error('Wallet infrastructure not found.');

            // [8] Global Strict PIN Validation Engine
            await verifyAndHandlePin(user, walletCheck, pin);

            // [9] ATOMIC WALLET DEDUCTION
            const updatedWallet = await Wallet.findOneAndUpdate(
                { user: userId, availableBalance: { $gte: expectedAmount }, isFrozen: { $ne: true } },
                { $inc: { availableBalance: -expectedAmount, balance: -expectedAmount } },
                { session, new: true }
            );

            if (!updatedWallet) throw new Error(`Insufficient balance. You need ₦${expectedAmount.toLocaleString()} to upgrade.`);

            const currentAvail = sanitizeAmount(walletCheck.availableBalance);
            const newAvail = sanitizeAmount(updatedWallet.availableBalance);

            // Create Transaction
            const transaction = new Transaction({ 
                user: userId, type: 'withdrawal', description: `Account Upgrade to ${role.toUpperCase()} Node`, 
                amount: expectedAmount, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail), 
                status: 'success', provider: 'internal', reference: `UPG-${Date.now()}` 
            });
            await transaction.save({ session });

            // [7] Create Audit Log
            await createAuditLog({
                user: userId, transactionId: transaction._id, reference: transaction.providerReference, amount: expectedAmount,
                type: 'account_upgrade', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'User Upgrade API'
            }, session);

            // Update User Role
            user.role = role;
            await user.save({ session });

            await session.commitTransaction();
            session.endSession();

            // Emit Sockets
            if (request.server && request.server.io) {
               request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: updatedWallet.availableBalance.toString() });
               request.server.io.to(`user:${userId}`).emit('notification', { type: 'success', title: 'Upgrade Successful', message: `Welcome to the ${role.toUpperCase()} tier!` });
            }
            
            const refreshedUser = await User.findById(userId);
            reply.send({ success: true, message: `Upgrade to ${role.toUpperCase()} was successful!`, user: sanitizeUser(refreshedUser) });

        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'Failed to process account upgrade.'); }
}

module.exports = { getDashboardData, updatePreferences, updateProfile, getReferralTree, upgradeUser };
