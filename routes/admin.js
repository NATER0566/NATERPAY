const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const PaymentLink = require('../models/PaymentLink'); 
const Ad = require('../models/Ad'); 
const axios = require('axios'); 
const crypto = require('crypto');
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
    if (isNaN(num)) throw new Error('Invalid monetary amount.');
    return num;
};

// [5] TEXT SANITIZATION (XSS Protection)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 500) : '';

/* =========================================================================
   [NEW FIX] BANK DATA DECRYPTION ENGINE
========================================================================= */
const ENCRYPTION_KEY = process.env.BANK_ENCRYPTION_KEY ? Buffer.from(process.env.BANK_ENCRYPTION_KEY, 'hex') : null;

function decryptBankData(encryptedText) {
    if (!encryptedText || !ENCRYPTION_KEY) return null;
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 3) return null;
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedTextStr = parts[1];
        const authTag = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedTextStr, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted; 
    } catch (e) {
        return null;
    }
}

/* =========================================================================
   [6] REDIS RATE LIMITING ENGINE (Admin Abuse Protection)
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 60) {
    const identifier = request.user ? request.user._id : request.ip;
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
            status: params.status, source: params.source, details: params.details || {}
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

// ============================================================================
// USER & SYSTEM MANAGEMENT
// ============================================================================

async function getUsers(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_get_users', 60)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            page: Joi.number().min(1).default(1), limit: Joi.number().min(1).max(500).default(50),
            search: Joi.string().allow('', null), role: Joi.string().allow('', null), status: Joi.string().allow('', null)
        });
        const { error, value } = schema.validate(request.query);
        if (error) throw error;

        const query = {};
        if (value.search) {
            const safeSearch = sanitizeText(value.search);
            query.$or = [{ name: { $regex: safeSearch,$options: 'i' } }, { email: { $regex: safeSearch,$options: 'i' } }, { phoneNumber: { $regex: safeSearch,$options: 'i' } }];
        }
        if (value.role) query.role = sanitizeText(value.role);
        if (value.status === 'active') query.isActive = true;
        if (value.status === 'inactive') query.isActive = false;
        if (value.status === 'suspended') query.isSuspended = true;
        
        const users = await User.find(query).select('-password -transactionPin -otp').sort({ createdAt: -1 }).skip((value.page - 1) * value.limit).limit(value.limit).lean();
        for (let user of users) {
            const wallet = await Wallet.findOne({ user: user._id });
            user.walletBalance = wallet ? wallet.availableBalance.toString() : '0';
        }
        const total = await User.countDocuments(query);
        reply.send({ success: true, users, pagination: { page: value.page, limit: value.limit, total, pages: Math.ceil(total / value.limit) } });
    } catch (error) { handleError(reply, error, 'Failed to fetch users'); }
}

async function getUser(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_get_user', 120)) throw { status: 429, message: 'Too many requests.' };
        const { id } = request.params;
        const user = await User.findById(sanitizeText(id)).select('-password -transactionPin -otp');
        if (!user) throw { status: 404, message: 'User not found' };

        const wallet = await Wallet.findOne({ user: user._id });
        const kyc = await KYC.findOne({ user: user._id });
        const recentTransactions = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(10);
        reply.send({ success: true, user, wallet, kyc, recentTransactions });
    } catch (error) { handleError(reply, error, 'Failed to fetch user'); }
}

async function updateUser(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_update_user', 30)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            name: Joi.string().allow('', null), role: Joi.string().allow('', null),
            isActive: Joi.boolean(), isSuspended: Joi.boolean(),
            suspensionReason: Joi.string().allow('', null), isSecured: Joi.boolean()
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { id } = request.params;
        const user = await User.findById(sanitizeText(id));
        if (!user) throw { status: 404, message: 'User not found' };
        
        if (value.name) user.name = sanitizeText(value.name);
        if (value.role) user.role = sanitizeText(value.role);
        if (typeof value.isActive === 'boolean') user.isActive = value.isActive;
        if (typeof value.isSuspended === 'boolean') { 
            user.isSuspended = value.isSuspended; 
            user.suspensionReason = sanitizeText(value.suspensionReason); 
            user.suspendedAt = value.isSuspended ? new Date() : null; 
        }
        if (typeof value.isSecured === 'boolean') user.isSecured = value.isSecured;
        await user.save();
        
        await createAuditLog({ user: request.user._id, action: `Updated User: ${user.email}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'User updated successfully', user });
    } catch (error) { handleError(reply, error, 'Failed to update user'); }
}

async function getTransactions(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_get_tx', 60)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            page: Joi.number().min(1).default(1), limit: Joi.number().min(1).max(500).default(50),
            type: Joi.string().allow('', null), status: Joi.string().allow('', null)
        });
        const { error, value } = schema.validate(request.query);
        if (error) throw error;

        const query = {};
        if (value.type) query.type = sanitizeText(value.type);
        if (value.status) query.status = sanitizeText(value.status);
        
        const transactions = await Transaction.find(query).populate('user', 'name email phoneNumber').sort({ createdAt: -1 }).skip((value.page - 1) * value.limit).limit(value.limit).lean();
        const formattedTx = transactions.map(tx => ({ ...tx, userEmail: tx.user ? tx.user.email : 'Unknown User' }));
        const total = await Transaction.countDocuments(query);
        
        reply.send({ success: true, transactions: formattedTx, pagination: { page: value.page, limit: value.limit, total, pages: Math.ceil(total / value.limit) } });
    } catch (error) { handleError(reply, error, 'Failed to fetch transactions'); }
}

async function getAnalytics(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_analytics', 30)) throw { status: 429, message: 'Too many requests.' };

        const userCount = await User.countDocuments({ isActive: true });
        const transactionCount = await Transaction.countDocuments({ status: 'success' });
        const pendingKYC = await KYC.countDocuments({ status: 'under_review' });
        const openTickets = await SupportTicket.countDocuments({ status: 'open' });
        const wallets = await Wallet.find({});
        const totalVaultBalance = wallets.reduce((acc, w) => acc + parseFloat(w.availableBalance?.toString() || '0'), 0);
        
        reply.send({ success: true, summary: { totalUsers: userCount, totalTransactions: transactionCount, pendingKYC, openTickets, totalVaultBalance } });
    } catch (error) { handleError(reply, error, 'Failed to fetch analytics'); }
}

// ============================================================================
// ENTERPRISE WITHDRAWAL MANAGEMENT (ATOMIC AUTO-REFUND & AUDIT ENGINE)
// ============================================================================

async function getPendingWithdrawals(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_withdrawals', 60)) throw { status: 429, message: 'Too many requests.' };
        
        const pendingWithdrawals = await Transaction.find({ type: 'withdrawal', status: 'processing' })
            .populate('user', 'name email phoneNumber')
            .sort({ createdAt: -1 })
            .lean();
            
        const formattedWithdrawals = pendingWithdrawals.map(tx => {
            if (tx.metadata && tx.metadata.encryptedData && ENCRYPTION_KEY) {
                const decrypted = decryptBankData(tx.metadata.encryptedData);
                if (decrypted) {
                    const [rawAccount, rawName] = decrypted.split(':');
                    tx.realAccountNumber = rawAccount;
                    tx.realAccountName = rawName;
                }
            }
            if (!tx.realAccountNumber) tx.realAccountNumber = tx.metadata?.bankAccount?.accountNumber || tx.accountNumber;
            if (!tx.realAccountName) tx.realAccountName = tx.metadata?.bankAccount?.accountName || tx.accountName;
            
            return tx;
        });

        reply.send({ success: true, pendingWithdrawals: formattedWithdrawals });
    } catch (error) { handleError(reply, error, 'Failed to fetch pending withdrawals.'); }
}

async function processWithdrawal(request, reply) {
    if (!await checkRateLimit(request, 'admin_process_withdrawal', 30)) return reply.status(429).send({ success: false, message: 'Too many requests.' });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const schema = Joi.object({ reason: Joi.string().allow('', null) });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { id, action } = request.params; 
        const safeAction = sanitizeText(action);
        
        const transaction = await Transaction.findOne({ _id: sanitizeText(id), type: 'withdrawal', status: 'processing' }).populate('user', 'name email').session(session);
        if (!transaction) throw new Error('Invalid or already processed transaction.');

        if (safeAction === 'approve') {
            transaction.status = 'success';
            transaction.metadata = transaction.metadata || {};
            transaction.metadata.approvedBy = request.user?._id;
            transaction.metadata.approvedAt = new Date();
            await transaction.save({ session });

            await createAuditLog({
                user: transaction.user._id, transactionId: transaction._id, reference: transaction.providerReference, amount: transaction.amount,
                type: 'withdrawal_approve', previousBalance: transaction.balanceAfter, newBalance: transaction.balanceAfter, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`
            }, session);

            if (Notification && typeof Notification.create === 'function') {
                await Notification.create({ user: transaction.user._id, title: 'Withdrawal Approved', message: `Your withdrawal of ₦${transaction.amount} has been successfully sent.`, type: 'success', priority: 'high' }).catch(e=>e);
            }

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${transaction.user._id}`).emit('notification', { title: 'Withdrawal Approved', message: 'Funds sent to bank!', type: 'success' });
            return reply.send({ success: true, message: 'Withdrawal approved and marked as success.' });

        } else if (safeAction === 'reject') {
            const wallet = await Wallet.findOne({ user: transaction.user._id }).session(session);
            if (!wallet) throw new Error('User wallet not found for refund.');

            const refundAmount = sanitizeAmount(Number(transaction.amount) + Number(transaction.fee));
            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentTotal = sanitizeAmount(wallet.balance);
            const newAvail = currentAvail + refundAmount;

            wallet.availableBalance = String(newAvail);
            wallet.balance = String(currentTotal + refundAmount);
            await wallet.save({ session });

            transaction.status = 'failed';
            transaction.balanceAfter = String(newAvail); 
            transaction.metadata = transaction.metadata || {};
            transaction.metadata.rejectionReason = sanitizeText(value.reason) || 'Rejected by Administrator';
            transaction.metadata.rejectedBy = request.user?._id;
            transaction.metadata.rejectedAt = new Date();
            await transaction.save({ session });

            await createAuditLog({
                user: transaction.user._id, transactionId: transaction._id, reference: transaction.providerReference, amount: refundAmount,
                type: 'withdrawal_refund', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: `Admin API: ${request.user._id}`
            }, session);

            if (Notification && typeof Notification.create === 'function') {
                await Notification.create({ user: transaction.user._id, title: 'Withdrawal Rejected', message: `Your ₦${transaction.amount} withdrawal was rejected. Funds refunded.`, type: 'error', priority: 'high' }).catch(e=>e);
            }

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) {
                request.server.io.to(`user:${transaction.user._id}`).emit('wallet:update', { balance: wallet.availableBalance });
                request.server.io.to(`user:${transaction.user._id}`).emit('notification', { type: 'error', title: 'Withdrawal Rejected', message: `Refunded: ${sanitizeText(value.reason) || 'Admin decision'}` });
            }
            return reply.send({ success: true, message: `Withdrawal rejected. ₦${refundAmount} has been safely refunded to user.` });
        } else {
            throw new Error('Invalid action.');
        }
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(reply, error, 'Failed to process withdrawal.');
    }
}

// ============================================================================
// DIRECT PAYSTACK KYC VERIFICATION ENGINE
// ============================================================================

async function getPendingKYC(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_get_kyc', 60)) throw { status: 429, message: 'Too many requests.' };
        const pendingKYC = await KYC.find({ status: 'under_review' }).populate('user', 'name email phoneNumber').sort({ createdAt: 1 });
        reply.send({ success: true, kycRequests: pendingKYC });
    } catch (error) { handleError(reply, error, 'Failed to fetch pending KYC requests'); }
}

async function verifyRealWorldKYC(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_verify_kyc_api', 30)) throw { status: 429, message: 'Too many requests.' };
        const { kycId } = request.params;
        const kycRecord = await KYC.findById(sanitizeText(kycId)).populate('user', 'name');
        
        if (!kycRecord) throw { status: 404, message: 'KYC record not found' };
        
        const bvn = kycRecord.level1?.bvn;
        if (!bvn) throw { status: 400, message: 'No BVN provided by user to verify.' };

        try {
            const paystackResponse = await axios.get(`https://api.paystack.co/bank/resolve_bvn/${bvn}`, {
                headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, timeout: 15000
            });
            const paystackData = paystackResponse.data.data;
            return reply.send({ success: true, message: 'Paystack verification complete', systemName: kycRecord.user.name, paystackDetails: { firstName: paystackData.first_name, lastName: paystackData.last_name, dob: paystackData.formatted_dob, phone: paystackData.mobile } });
        } catch (paystackError) {
            const errorMessage = paystackError.response?.data?.message || 'Paystack BVN service is offline or rejected the request.';
            throw { status: 400, message: `Paystack Error: ${errorMessage}` };
        }
    } catch (error) { handleError(reply, error, 'Server error during verification.'); }
}

async function approveKYC(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_approve_kyc', 30)) throw { status: 429, message: 'Too many requests.' };
        const { kycId } = request.params;
        const kyc = await KYC.findById(sanitizeText(kycId));
        if (!kyc) throw { status: 404, message: 'KYC not found' };

        const user = await User.findById(kyc.user);
        if (!user) throw { status: 404, message: 'User not found' };
        
        if (kyc.currentLevel === 1) { await kyc.approveLevel1(request.user._id); user.kycLevel = 1; } 
        else if (kyc.currentLevel === 2) { await kyc.approveLevel2(request.user._id); user.kycLevel = 2; } 
        else if (kyc.currentLevel === 3) { await kyc.approveLevel3(request.user._id); user.kycLevel = 3; }
        
        await user.save();
        await createAuditLog({ user: request.user._id, action: `Approved KYC Level ${kyc.currentLevel} for ${user.email}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });

        if (request.server && request.server.io) request.server.io.to(`user:${user._id}`).emit('notification', { title: 'KYC Approved', message: `Your Tier ${kyc.currentLevel} verification is approved!` });
        reply.send({ success: true, message: 'KYC approved successfully' });
    } catch (error) { handleError(reply, error, 'Server error during KYC approval'); }
}

async function rejectKYC(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_reject_kyc', 30)) throw { status: 429, message: 'Too many requests.' };
        
        const schema = Joi.object({ reason: Joi.string().allow('', null) });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { kycId } = request.params;
        const reason = sanitizeText(value.reason) || 'Your provided details could not be verified.';
        
        const kyc = await KYC.findById(sanitizeText(kycId));
        if (!kyc) throw { status: 404, message: 'KYC not found' };

        await kyc.reject(reason);
        await createAuditLog({ user: request.user._id, action: `Rejected KYC for user ${kyc.user}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });

        if (request.server && request.server.io) request.server.io.to(`user:${kyc.user}`).emit('notification', { title: 'KYC Rejected', message: `Reason: ${kyc.rejectionReason}` });
        reply.send({ success: true, message: 'KYC rejected successfully.' });
    } catch (error) { handleError(reply, error, 'Server error during KYC rejection'); }
}

// ============================================================================
// MARKETPLACE MODERATION ENGINES
// ============================================================================

async function updateProduct(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_update_product', 30)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            title: Joi.string().allow('', null), amount: Joi.number().allow('', null),
            category: Joi.string().allow('', null), description: Joi.string().allow('', null)
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { id } = request.params;
        const product = await PaymentLink.findById(sanitizeText(id));
        if (!product) throw { status: 404, message: 'Product item not found' };

        if (value.title) product.title = sanitizeText(value.title);
        if (value.category) product.category = sanitizeText(value.category);
        if (value.description) product.description = sanitizeText(value.description);
        if (value.amount !== undefined && value.amount !== null && !product.isFlexibleAmount) product.amount = String(sanitizeAmount(value.amount));

        await product.save();
        await createAuditLog({ user: request.user._id, action: `Admin Updated Product: ${product.linkId}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });

        reply.send({ success: true, message: 'Product listing modified successfully', product });
    } catch (error) { handleError(reply, error, 'Failed to update marketplace item'); }
}

async function deleteProduct(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_delete_product', 20)) throw { status: 429, message: 'Too many requests.' };
        const { id } = request.params;
        const product = await PaymentLink.findByIdAndDelete(sanitizeText(id));
        if (!product) throw { status: 404, message: 'Listing already purged or not found' };
        
        await createAuditLog({ user: request.user._id, action: `Admin Deleted Product: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Product completely purged from global ledger' });
    } catch (error) { handleError(reply, error, 'Failed to delete product from ledger'); }
}

// ============================================================================
// ENTERPRISE ADVERTS MODERATION ENGINE (ATOMIC REFUND)
// ============================================================================

async function getPendingAds(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_get_ads', 60)) throw { status: 429, message: 'Too many requests.' };
        const ads = await Ad.find({}).populate('user', 'name email').sort({ status: -1, createdAt: -1 }); 
        reply.send({ success: true, ads });
    } catch (error) { handleError(reply, error, 'Failed to fetch adverts'); }
}

async function approveAd(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_approve_ad', 30)) throw { status: 429, message: 'Too many requests.' };
        const { id } = request.params;
        const ad = await Ad.findById(sanitizeText(id));
        if (!ad) throw { status: 404, message: 'Advert not found' };
        
        ad.status = 'approved';
        await ad.save();

        await createAuditLog({ user: request.user._id, action: `Admin Approved Ad: ${ad._id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        if (request.server && request.server.io) request.server.io.to(`user:${ad.user}`).emit('notification', { title: 'Campaign Approved!', type: 'success', message: `Your campaign "${ad.title}" is now LIVE.` });
        
        reply.send({ success: true, message: 'Advert approved and is now live.' });
    } catch (error) { handleError(reply, error, 'Failed to approve advert'); }
}

async function rejectAd(request, reply) {
    if (!await checkRateLimit(request, 'admin_reject_ad', 20)) return reply.status(429).send({ success: false, message: 'Too many requests.' });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { id } = request.params;
        const ad = await Ad.findOne({ _id: sanitizeText(id), status: { $ne: 'rejected' } }).session(session);
        if (!ad) throw new Error('Advert not found or already rejected.');
        
        const totalRefund = sanitizeAmount(Number(ad.packageCost || 0) + Number(ad.viewBudgetCost || 0));
        
        const wallet = await Wallet.findOne({ user: ad.user }).session(session);
        if (wallet) {
            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentLedger = sanitizeAmount(wallet.balance);
            const newAvail = currentAvail + totalRefund;
            
            wallet.availableBalance = String(newAvail);
            wallet.balance = String(currentLedger + totalRefund);
            await wallet.save({ session });

            const refundTx = new Transaction({
                user: ad.user, type: 'funding', description: `Refund: Rejected Campaign (${ad.title})`,
                amount: totalRefund, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
                status: 'success', provider: 'internal', providerReference: `REF-AD-${Date.now()}`
            });
            await refundTx.save({ session });

            await createAuditLog({
                user: ad.user, transactionId: refundTx._id, reference: refundTx.providerReference, amount: totalRefund,
                type: 'ad_refund', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`
            }, session);

            if (request.server && request.server.io) request.server.io.to(`user:${ad.user}`).emit('wallet:update', { balance: wallet.availableBalance });
        }
        
        ad.status = 'rejected';
        await ad.save({ session });

        await session.commitTransaction();
        session.endSession();

        if (request.server && request.server.io) request.server.io.to(`user:${ad.user}`).emit('notification', { title: 'Campaign Rejected', type: 'error', message: `Campaign "${ad.title}" rejected. Funds refunded.` });
        reply.send({ success: true, message: 'Advert rejected and funds fully refunded.' });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(reply, error, 'Failed to reject advert');
    }
}

async function deleteAd(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_delete_ad', 20)) throw { status: 429, message: 'Too many requests.' };
        const { id } = request.params;
        const ad = await Ad.findByIdAndDelete(sanitizeText(id));
        if (!ad) throw { status: 404, message: 'Advert already deleted or not found' };
        
        await createAuditLog({ user: request.user._id, action: `Admin Deleted Ad: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Advert permanently obliterated from database.' });
    } catch (error) { handleError(reply, error, 'Failed to permanently delete advert'); }
}

// ============================================================================
// ADMIN UTILITIES (ATOMIC LEDGER MANAGEMENT)
// ============================================================================

async function updateUserBalance(request, reply) {
    if (!await checkRateLimit(request, 'admin_update_balance', 20)) return reply.status(429).send({ success: false, message: 'Too many requests.' });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const schema = Joi.object({
            action: Joi.string().valid('credit', 'debit').required(),
            amount: Joi.number().min(1).required(),
            reason: Joi.string().required()
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { id } = request.params;
        const { action, amount, reason } = value;

        const wallet = await Wallet.findOne({ user: sanitizeText(id) }).session(session);
        if (!wallet) throw new Error('User wallet not found');

        const currentAvail = sanitizeAmount(wallet.availableBalance);
        const currentLedger = sanitizeAmount(wallet.balance);
        const amountFloat = sanitizeAmount(amount);

        let newAvail, newLedger;

        if (action === 'credit') {
            newAvail = currentAvail + amountFloat;
            newLedger = currentLedger + amountFloat;
        } else if (action === 'debit') {
            if (currentAvail < amountFloat) throw new Error('Insufficient user balance for this debit.');
            newAvail = currentAvail - amountFloat;
            newLedger = currentLedger - amountFloat;
        }

        wallet.availableBalance = String(newAvail);
        wallet.balance = String(newLedger);
        await wallet.save({ session });

        const adminTx = new Transaction({
            user: id, type: action === 'credit' ? 'funding' : 'withdrawal', description: `Admin ${action.toUpperCase()}: ${sanitizeText(reason)}`, 
            amount: amountFloat, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
            status: 'success', provider: 'internal', providerReference: `ADM-${Date.now()}`
        });
        await adminTx.save({ session }); 

        await createAuditLog({
            user: id, transactionId: adminTx._id, reference: adminTx.providerReference, amount: amountFloat,
            type: action === 'credit' ? 'admin_credit' : 'admin_debit', previousBalance: currentAvail, newBalance: newAvail, 
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`, details: { reason: sanitizeText(reason) }
        }, session);

        await session.commitTransaction();
        session.endSession();

        if (request.server && request.server.io) request.server.io.to(`user:${id}`).emit('wallet:update', { balance: wallet.availableBalance });
        reply.send({ success: true, message: `Wallet ${action}ed successfully!`, newBalance: wallet.availableBalance });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(reply, error, 'Failed to update ledger balance.');
    }
}

async function verifyTransaction(request, reply) {
    if (!await checkRateLimit(request, 'admin_verify_tx', 30)) return reply.status(429).send({ success: false, message: 'Too many requests.' });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const schema = Joi.object({ transactionId: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const tx = await Transaction.findById(sanitizeText(value.transactionId)).session(session);
        
        if (!tx) throw new Error('Transaction not found');
        if (tx.status === 'success') throw new Error('Transaction is already verified');

        const txAmount = sanitizeAmount(tx.amount);

        if (tx.type === 'funding' || tx.type === 'wallet_fund') {
            const wallet = await Wallet.findOne({ user: tx.user }).session(session);
            if (!wallet) throw new Error('User wallet not found');

            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentLedger = sanitizeAmount(wallet.balance);
            
            const newAvail = currentAvail + txAmount;
            const newLedger = currentLedger + txAmount;

            tx.balanceAfter = String(newAvail);
            tx.status = 'success';
            tx.metadata = tx.metadata || {};
            tx.metadata.forcedVerifyBy = request.user._id;
            await tx.save({ session }); 

            wallet.availableBalance = String(newAvail);
            wallet.balance = String(newLedger);
            await wallet.save({ session });
            
            await createAuditLog({
                user: tx.user, transactionId: tx._id, reference: tx.providerReference, amount: txAmount,
                type: 'admin_force_verify', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`
            }, session);

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${tx.user}`).emit('wallet:update', { balance: wallet.availableBalance });
        } else {
            tx.status = 'success';
            tx.metadata = tx.metadata || {};
            tx.metadata.forcedVerifyBy = request.user._id;
            await tx.save({ session });

            await session.commitTransaction();
            session.endSession();
        }

        reply.send({ success: true, message: 'Transaction force-verified successfully' });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(reply, error, 'Failed to verify transaction');
    }
}

async function sendPushNotification(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_push_notif', 20)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            targetEmail: Joi.string().allow('', null, 'ALL'), title: Joi.string().required(),
            message: Joi.string().required(), type: Joi.string().default('info'), fileData: Joi.string().allow('', null)
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;
        
        if (value.targetEmail === 'ALL' || !value.targetEmail) {
            if (request.server && request.server.io) request.server.io.emit('notification', { title: sanitizeText(value.title), message: sanitizeText(value.message), type: value.type, image: value.fileData });
            await createAuditLog({ user: request.user._id, action: `Broadcast Notification: ${value.title}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
            return reply.send({ success: true, message: 'Broadcast transmitted' });
        }

        const user = await User.findOne({ email: sanitizeText(value.targetEmail).toLowerCase() });
        if (!user) throw { status: 404, message: 'Target user not found' };

        if (Notification && typeof Notification.create === 'function') {
            await Notification.create({ user: user._id, title: sanitizeText(value.title), message: sanitizeText(value.message), type: 'system', priority: 'high' });
        }

        if (request.server && request.server.io) request.server.io.to(`user:${user._id}`).emit('notification', { title: sanitizeText(value.title), message: sanitizeText(value.message), type: value.type, image: value.fileData });
        
        await createAuditLog({ user: request.user._id, action: `Sent Notification to ${user.email}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Notification transmitted to user' });
    } catch (error) { handleError(reply, error, 'Failed to transmit notification'); }
}

/* =========================================================================
   [NEW FIX] ENTERPRISE TICKET AGGREGATOR
========================================================================= */
async function getSupportTickets(request, reply) {
    try {
        const SupportTicket = require('../models/SupportTicket');
        const tickets = await SupportTicket.find({})
            .populate('user', 'name email phoneNumber kycLevel role')
            .sort({ createdAt: -1 });
            
        return reply.status(200).send({ success: true, tickets });
    } catch (error) {
        return reply.status(500).send({ success: false, message: 'Failed to fetch all tickets' });
    }
}

async function assignTicket(request, reply) { reply.send({ success: true, message: 'Assigned' }); }
async function resolveTicket(request, reply) { reply.send({ success: true, message: 'Resolved' }); }

/* =========================================================================
   [NEW] FORCE DELETE & ADVANCED EDIT ENGINES
========================================================================= */
async function deleteTicket(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_del_ticket', 30)) throw { status: 429, message: 'Too many requests.' };
        const SupportTicket = require('../models/SupportTicket');
        await SupportTicket.findOneAndDelete({ ticketId: sanitizeText(request.params.id) });
        reply.send({ success: true, message: 'Ticket permanently wiped.' });
    } catch (e) { handleError(reply, e, 'Failed to delete ticket'); }
}

async function deleteKycRecord(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_del_kyc', 30)) throw { status: 429, message: 'Too many requests.' };
        await KYC.findByIdAndDelete(sanitizeText(request.params.id));
        reply.send({ success: true, message: 'Corrupted KYC record wiped.' });
    } catch (e) { handleError(reply, e, 'Failed to delete KYC'); }
}

// ============================================================================
// INVOICE MANAGEMENT (ADMIN)
// ============================================================================
async function getInvoices(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_get_invoices', 60)) throw { status: 429, message: 'Too many requests.' };
        const Invoice = require('../models/Invoice');
        
        // [FIXED] Force MongoDB to attach the real user data instead of leaving it blank!
        const invoices = await Invoice.find({})
            .populate('user', 'name email kycLevel role phoneNumber')
            .populate('merchantId', 'name email kycLevel role phoneNumber')
            .sort({ createdAt: -1 })
            .lean();
            
        reply.send({ success: true, invoices });
    } catch (error) { handleError(reply, error, 'Failed to fetch global invoices'); }
}

async function updateInvoice(request, reply) {
    try {
        const Invoice = require('../models/Invoice');
        const inv = await Invoice.findById(sanitizeText(request.params.id));
        if (!inv) throw new Error('Invoice not found');
        
        if (request.body.customerName) inv.customerName = sanitizeText(request.body.customerName);
        if (request.body.customerEmail) inv.customerEmail = sanitizeText(request.body.customerEmail);
        if (request.body.total !== undefined) inv.total = String(sanitizeAmount(request.body.total));
        if (request.body.status) inv.status = sanitizeText(request.body.status);
        
        await inv.save();
        reply.send({ success: true, message: 'Invoice updated' });
    } catch (e) { handleError(reply, e, 'Failed to update invoice'); }
}

async function editAd(request, reply) {
    try {
        const ad = await Ad.findById(sanitizeText(request.params.id));
        if (!ad) throw new Error('Ad not found');
        
        if (request.body.title) ad.title = sanitizeText(request.body.title);
        if (request.body.businessName) ad.businessName = sanitizeText(request.body.businessName);
        if (request.body.maxRewardedViews !== undefined) ad.maxRewardedViews = parseInt(request.body.maxRewardedViews, 10) || 0;
        
        await ad.save();
        reply.send({ success: true, message: 'Ad updated' });
    } catch (e) { handleError(reply, e, 'Failed to update ad'); }
}

module.exports = {
  getUsers, getUser, updateUser, getTransactions, getAnalytics, 
  getSupportTickets, assignTicket, resolveTicket,
  updateUserBalance, verifyTransaction, sendPushNotification,
  getPendingWithdrawals, processWithdrawal, 
  getPendingKYC, verifyRealWorldKYC, approveKYC, rejectKYC,
  updateProduct, deleteProduct,
  getPendingAds, approveAd, rejectAd, deleteAd,
  deleteTicket, deleteKycRecord, updateInvoice, editAd,
  getInvoices
};
