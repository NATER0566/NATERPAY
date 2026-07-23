const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const config = require('../config');
const axios = require('axios');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const Joi = require('joi'); 

// [6] STRUCTURED LOGGING ENGINE (Pino)
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

// [11] ENVIRONMENT VARIABLES ONLY
const APP_URL = config.appUrl || process.env.APP_URL || 'http://localhost:5000';
const PAYSTACK_BASE_URL = config.paystack?.baseUrl || process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

// [19] TRANSACTION STATUS & PROVIDER CONSTANTS
const TX_STATUS = { PENDING: 'pending', PROCESSING: 'processing', SUCCESS: 'success', FAILED: 'failed' };
const PROVIDERS = { PAYSTACK: 'paystack', MANUAL: 'manual', INTERNAL: 'internal' };

// Dynamic Imports
let AuditLog, Notification, generateIdempotencyKey, generateTransactionReference, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}
try { 
    const authUtils = require('../utils/auth');
    generateIdempotencyKey = authUtils.generateIdempotencyKey;
    generateTransactionReference = authUtils.generateTransactionReference;
} catch(e) {}

/* =========================================================================
   [16] CENTRALIZED ERROR HANDLING
========================================================================= */
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) {
        return reply.status(400).send({ success: false, message: error.details[0].message });
    }
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

/* =========================================================================
   [1] MONEY PRECISION HELPER
========================================================================= */
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    if (isNaN(num) || num <= 0) throw new Error('Invalid monetary amount.');
    return num;
};

/* =========================================================================
   [10] SANITIZATION HELPER (XSS Protection)
========================================================================= */
const sanitizeText = (str) => {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim().substring(0, 255);
};

/* =========================================================================
   [5] & [4] NETWORK RETRY & TIMEOUT MECHANISM
========================================================================= */
async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1 || (err.response && err.response.status >= 400 && err.response.status < 500)) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
}

/* =========================================================================
   [2] AES-256-GCM BANK INFO ENCRYPTION
========================================================================= */
const ENCRYPTION_KEY = process.env.BANK_ENCRYPTION_KEY ? Buffer.from(process.env.BANK_ENCRYPTION_KEY, 'hex') : crypto.randomBytes(32);
function encryptBankData(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

/* =========================================================================
   [23] & [8] REDIS / DISTRIBUTED RATE LIMITING ENGINE
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action) {
    const ip = request.ip;
    const userId = request.user ? request.user._id : 'anon';
    const limit = 5; 
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const ipKey = `rate_${action}_ip_${ip}`;
        const userKey = `rate_${action}_user_${userId}`;

        const checkKey = (key) => {
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

        if (!checkKey(ipKey) || !checkKey(userKey)) return false;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const ipKey = `rate:${action}:ip:${ip}`;
            const userKey = `rate:${action}:user:${userId}`;

            const [ipCount, userCount] = await Promise.all([
                redisClient.incr(ipKey), redisClient.incr(userKey)
            ]);

            if (ipCount === 1) await redisClient.expire(ipKey, windowSeconds);
            if (userCount === 1) await redisClient.expire(userKey, windowSeconds);

            if (ipCount > limit || userCount > limit) return false;
            return true;
        } catch (err) {
            return executeFallback();
        }
    } else {
        return executeFallback();
    }
}

/* =========================================================================
   DAILY TRANSACTION LIMITS ENGINE
========================================================================= */
async function checkDailyLimit(userId, type, amount, limit) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const txs = await Transaction.aggregate([
        { $match: { user: userId, type: type, status: { $in: [TX_STATUS.SUCCESS, TX_STATUS.PENDING, TX_STATUS.PROCESSING] }, createdAt: { $gte: startOfDay } } },
        { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } }
    ]);
    
    const totalToday = txs.length > 0 ? txs[0].total : 0;
    if (totalToday + amount > limit) throw new Error(`Daily ${type} limit of ₦${limit.toLocaleString()} exceeded.`);
}

/* =========================================================================
   [18] IMMUTABLE AUDIT LOGGING ENGINE
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
        if (session) await log.save({ session });
        else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

/* =========================================================================
   IDEMPOTENCY ENFORCEMENT ENGINE
========================================================================= */
async function checkIdempotency(request, type) {
    const idemKey = request.headers['x-idempotency-key'];
    if (idemKey) {
        const existingTx = await Transaction.findOne({ idempotencyKey: idemKey, user: request.user._id, type });
        if (existingTx) return existingTx;
    }
    return null;
}

/* =========================================================================
   SYSTEM NOTIFICATION ENGINE
========================================================================= */
async function sendSystemNotification(user, title, message, type, request, session = null) {
    if (!Notification) return;
    try {
        const notif = new Notification({ user, title, message: sanitizeText(message), type, isRead: false });
        if (session) await notif.save({ session });
        else await notif.save();
        if (request.server && request.server.io) {
            request.server.io.to(`user:${user}`).emit('notification:new', notif);
        }
    } catch(e) { logger.error('Notification Engine Error', e); }
}

/* =========================================================================
   [26] STRICT STATE TRANSITION PROTECTION HELPER
========================================================================= */
async function failTransactionStrictly(txId, reason, request, source) {
    const failedTx = await Transaction.findOneAndUpdate(
        { _id: txId, status: { $in: [TX_STATUS.PENDING, TX_STATUS.PROCESSING] } },
        { $set: { status: TX_STATUS.FAILED, description: sanitizeText(reason) } },
        { new: true }
    );
    if (failedTx) {
        await createAuditLog({
            user: failedTx.user, transactionId: failedTx._id, reference: failedTx.providerReference, amount: failedTx.amount,
            type: failedTx.type, previousBalance: failedTx.balanceBefore || '0', newBalance: failedTx.balanceAfter || '0',
            ipAddress: request ? request.ip : 'SYSTEM', userAgent: request ? request.headers['user-agent'] : 'SYSTEM',
            status: TX_STATUS.FAILED, source: source
        });
    }
    return failedTx;
}

/* =========================================================================
   HELPER: PIN SECURITY ENGINE
========================================================================= */
async function verifyAndHandlePin(user, wallet, providedPin) {
    if (user.pinLockUntil && user.pinLockUntil > new Date()) {
        throw new Error(`Security Lock: PIN blocked until ${user.pinLockUntil.toLocaleTimeString()}.`);
    }

    let isPinValid = false; 
    if (typeof wallet.verifyPin === 'function') { 
        isPinValid = await wallet.verifyPin(String(providedPin)); 
    } else if (user.transactionPin) { 
        isPinValid = await bcrypt.compare(String(providedPin), user.transactionPin); 
    } else { 
        throw new Error('Please setup your withdrawal PIN in settings first.'); 
    } 
    
    if (!isPinValid) { 
        const failedAttempts = (user.failedPinAttempts || 0) + 1; 
        let updateDoc = { failedPinAttempts: failedAttempts }; 
        if (failedAttempts >= 3) { 
            updateDoc.pinLockUntil = new Date(Date.now() + 15 * 60000); 
            updateDoc.failedPinAttempts = 0; 
        } 
        await User.updateOne({ _id: user._id }, { $set: updateDoc }); 
        throw new Error(failedAttempts >= 3 ? 'SECURITY ALERT: Maximum attempts reached. Transfers locked for 15 minutes.' : `SECURITY ALERT: Incorrect PIN. ${3 - failedAttempts} attempts remaining.`); 
    } 
    
    if (user.failedPinAttempts > 0) { 
        await User.updateOne({ _id: user._id }, { $set: { failedPinAttempts: 0, pinLockUntil: null } }); 
    } 
    return true; 
}

/* =========================================================================
   1. GET WALLET
========================================================================= */
async function getWallet(request, reply) {
    try {
        const wallet = await Wallet.findOne({ user: request.user._id });
        if (!wallet) throw new Error('Wallet not found');
        reply.send({ success: true, wallet });
    } catch (error) { handleError(reply, error, 'Failed to fetch wallet'); }
}

/* =========================================================================
   2. INITIALIZE FUNDING (PAYSTACK) - [FIXED MONGOOSE BALANCE BUG]
========================================================================= */
async function fundWallet(request, reply) {
    try {
        const schema = Joi.object({ 
            amount: Joi.number().min(100).required(), 
            provider: Joi.string().default('paystack'),
            callbackUrl: Joi.string().uri().allow('', null).optional()
        });
        
        const { error, value } = schema.validate(request.body);
        if (error) throw { status: 400, message: error.details[0].message };

        if (!await checkRateLimit(request, 'fund_init', 10)) throw { status: 429, message: 'Too many funding attempts.' };

        const amount = sanitizeAmount(value.amount);
        
        let fee = amount < 2500 ? (amount * 0.015) / (1 - 0.015) : ((amount * 0.015) + 100) / (1 - 0.015);
        if (fee > 2000) fee = 2000;
        fee = Math.ceil(fee);
        const totalCharge = amount + fee;

        const txReference = 'TX_FND_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex').toUpperCase();

        const liveDashboardUrl = value.callbackUrl || `${request.protocol}://${request.hostname}/dashboard.html`;

        // [FIX] Fetch wallet to satisfy Mongoose's requirement for balanceBefore/balanceAfter
        const wallet = await Wallet.findOne({ user: request.user._id });
        if (!wallet) throw new Error("Wallet not found");
        const startBalance = String(wallet.availableBalance || '0');

        const paystackRes = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: request.user.email,
            amount: Math.round(totalCharge * 100),
            reference: txReference,
            callback_url: liveDashboardUrl,
            metadata: { userId: request.user._id.toString(), type: 'wallet_fund', amount: amount, fee: fee }
        }, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });

        const transaction = new Transaction({
            user: request.user._id, type: 'funding', description: 'Wallet Funding via Paystack',
            amount: amount, fee: fee, status: 'pending', provider: 'paystack', providerReference: txReference,
            balanceBefore: startBalance, // [FIXED ERROR 1]
            balanceAfter: startBalance   // [FIXED ERROR 1]
        });
        await transaction.save();

        reply.send({ success: true, paymentReference: txReference, checkoutUrl: paystackRes.data.data.authorization_url });
    } catch (error) {
        reply.status(error.status || 500).send({ success: false, message: error.message || 'Failed to initialize payment' });
    }
}

/* =========================================================================
   MANUAL BANK TRANSFER FUNDING [FIXED FASTIFY MULTIPART FORM BUG]
========================================================================= */
async function fundManualWallet(request, reply) {
    try {
        let amountRaw = null;
        let narrationRaw = '';
        let fileBuffer = null;
        let mimeType = null;

        // [FIXED ERROR 2] Safely parse Multipart FormData (Images/Files)
        if (request.isMultipart && request.isMultipart()) {
            const parts = request.parts();
            for await (const part of parts) {
                if (part.type === 'file') {
                    fileBuffer = await part.toBuffer();
                    mimeType = part.mimetype;
                } else {
                    if (part.fieldname === 'amount') amountRaw = part.value;
                    if (part.fieldname === 'narration') narrationRaw = part.value;
                }
            }
        } else {
            amountRaw = request.body?.amount;
            narrationRaw = request.body?.narration;
        }

        if (!amountRaw) throw new Error('Amount is required.');
        if (!await checkRateLimit(request, 'fund_manual')) throw new Error('Too Many Requests.');

        const requestedAmount = sanitizeAmount(amountRaw);
        if (requestedAmount < (config.business?.minFunding || 100)) throw new Error(`Minimum funding is ₦${config.business?.minFunding || 100}`);

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ user: request.user._id }).session(session);
            if (!wallet) throw new Error('Wallet not found');

            const pendingManual = await Transaction.findOne({ user: request.user._id, provider: PROVIDERS.MANUAL, status: TX_STATUS.PROCESSING }).session(session);
            if (pendingManual) throw new Error('You already have a manual funding request currently Processing.');

            const existingTx = await checkIdempotency(request, 'funding_manual');
            if (existingTx) {
                await session.abortTransaction(); session.endSession();
                return reply.send({ success: true, message: 'Request already logged', paymentReference: existingTx.providerReference });
            }

            // Secure File Uploads natively via buffer
            let secureReceiptUrl = null;
            if (fileBuffer) {
                const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
                if (!allowedMimeTypes.includes(mimeType)) throw new Error('Invalid file type. Allowed: JPG, PNG, WEBP, PDF.');

                const fileToUpload = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
                const uploadResult = await withRetry(() => cloudinary.uploader.upload(fileToUpload, { folder: 'naterpay_receipts', resource_type: 'auto', timeout: 15000 }));
                secureReceiptUrl = uploadResult.secure_url;
            }

            const safeNarration = sanitizeText(narrationRaw) || 'Not Provided';
            const paymentReference = `MF-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const startBalance = String(wallet.availableBalance || 0);
            const idempotencyKey = request.headers['x-idempotency-key'] || `idem_man_${Date.now()}`;

            const transaction = new Transaction({
                user: request.user._id, type: 'funding', description: `Manual Bank Transfer`,
                amount: requestedAmount, fee: 0, balanceBefore: startBalance, balanceAfter: startBalance,
                status: TX_STATUS.PROCESSING, provider: PROVIDERS.MANUAL, providerReference: paymentReference,
                idempotencyKey: idempotencyKey, ipAddress: request.ip, userAgent: request.headers['user-agent'],
                metadata: { narration: safeNarration, receiptAttached: !!secureReceiptUrl, receiptUrl: secureReceiptUrl }
            });
            await transaction.save({ session });

            await createAuditLog({
                user: request.user._id, transactionId: transaction._id, reference: paymentReference, amount: requestedAmount,
                type: 'funding', previousBalance: startBalance, newBalance: startBalance, ipAddress: request.ip,
                userAgent: request.headers['user-agent'], status: TX_STATUS.PROCESSING, source: 'Manual Funding API'
            }, session);

            await sendSystemNotification(request.user._id, 'Manual Funding Submitted', `Your request to fund ₦${requestedAmount.toLocaleString()} is processing. Ref: ${paymentReference}`, 'funding', request, session);

            await session.commitTransaction();
            session.endSession();

            reply.send({ success: true, message: 'Manual funding request submitted.', paymentReference });
        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'System error processing manual funding.'); }
}

/* =========================================================================
   ADMIN APPROVE MANUAL FUNDING (ATOMIC)
========================================================================= */
async function adminApproveManualFunding(request, reply) {
    try {
        const schema = Joi.object({ transactionId: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        // [13] Protect Admin Routes
        const adminUser = await User.findById(request.user._id);
        if (!adminUser || (adminUser.role !== 'admin' && !adminUser.isAdmin)) throw { status: 403, message: 'Forbidden: Admin access required.' };

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // [14] Double-entry: Transaction records credit
            const tx = await Transaction.findOneAndUpdate(
                { _id: value.transactionId, status: TX_STATUS.PROCESSING, provider: PROVIDERS.MANUAL },
                { 
                    $set: { 
                        status: TX_STATUS.SUCCESS, 
                        'metadata.approvedBy': adminUser._id, 
                        'metadata.approvedAt': new Date() 
                    } 
                }, 
                { session, new: true }
            );

            if (!tx) throw new Error('Transaction not found or already processed.');

            const creditAmount = sanitizeAmount(tx.amount);
            const updatedWallet = await Wallet.findOneAndUpdate(
                { user: tx.user }, { $inc: { availableBalance: creditAmount, balance: creditAmount } }, { session, new: true }
            );

            tx.balanceBefore = String(sanitizeAmount(Number(updatedWallet.availableBalance) - creditAmount));
            tx.balanceAfter = String(updatedWallet.availableBalance);
            tx.description = 'Manual Bank Transfer (Approved)';
            await tx.save({ session });

            await createAuditLog({
                user: tx.user, transactionId: tx._id, reference: tx.providerReference, amount: creditAmount,
                type: 'funding', previousBalance: tx.balanceBefore, newBalance: tx.balanceAfter, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: TX_STATUS.SUCCESS, 
                source: `Admin API: ${adminUser.email}`, details: { approvedBy: adminUser._id }
            }, session);

            await sendSystemNotification(tx.user, 'Manual Deposit Approved', `Your bank transfer was verified. Your wallet has been credited with ₦${creditAmount.toLocaleString()}.`, 'funding', request, session);

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${tx.user}`).emit('wallet:update', { balance: String(updatedWallet.availableBalance) });

            reply.send({ success: true, message: 'Manual funding approved and wallet credited.' });
        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'Failed to approve manual funding.'); }
}

/* =========================================================================
   ADMIN REJECT MANUAL FUNDING
========================================================================= */
async function adminRejectManualFunding(request, reply) {
    try {
        const schema = Joi.object({ transactionId: Joi.string().required(), reason: Joi.string().allow('', null) });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        // [13] Protect Admin Routes
        const adminUser = await User.findById(request.user._id);
        if (!adminUser || (adminUser.role !== 'admin' && !adminUser.isAdmin)) throw { status: 403, message: 'Forbidden: Admin access required.' };

        const rejectionReason = sanitizeText(value.reason) || 'Payment not found in company bank account.';
        
        const failedTx = await Transaction.findOneAndUpdate(
            { _id: value.transactionId, status: TX_STATUS.PROCESSING, provider: PROVIDERS.MANUAL },
            { 
                $set: { 
                    status: TX_STATUS.FAILED, 
                    description: `Rejected: ${rejectionReason}`,
                    'metadata.rejectedBy': adminUser._id, 
                    'metadata.rejectedAt': new Date(),
                    'metadata.rejectionReason': rejectionReason
                } 
            },
            { new: true }
        );
        
        if (!failedTx) throw new Error('Transaction not found or already processed.');

        await createAuditLog({
            user: failedTx.user, transactionId: failedTx._id, reference: failedTx.providerReference, amount: failedTx.amount,
            type: 'funding', previousBalance: failedTx.balanceBefore, newBalance: failedTx.balanceAfter, 
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: TX_STATUS.FAILED, 
            source: `Admin API: ${adminUser.email}`, details: { rejectedBy: adminUser._id, reason: rejectionReason }
        });

        await sendSystemNotification(failedTx.user, 'Manual Deposit Rejected', `Your manual funding request was rejected. Reason: ${rejectionReason}`, 'funding', request);

        reply.send({ success: true, message: 'Manual funding request successfully rejected.' });
    } catch (error) { handleError(reply, error, 'Failed to reject manual funding.'); }
}

/* =========================================================================
   VERIFY FUNDING (ATOMIC)
========================================================================= */
async function verifyFunding(request, reply) {
    try {
        const schema = Joi.object({ reference: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'verify')) throw new Error('Too Many Requests.');
        
        const txCheck = await Transaction.findOne({ providerReference: value.reference }); 
        if (!txCheck) throw { status: 404, message: 'Transaction not found' }; 
        
        if (txCheck.status === TX_STATUS.SUCCESS) return reply.send({ success: true, message: 'Wallet already credited' }); 
        if (txCheck.status === TX_STATUS.FAILED) throw new Error('Transaction was cancelled or declined.'); 
        
        const response = await withRetry(() => axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${value.reference}`, { 
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, timeout: 15000 
        })); 
        const gatewayData = response.data.data; 
        
        if (gatewayData.status === 'abandoned' || gatewayData.status === 'failed') { 
            await failTransactionStrictly(txCheck._id, 'Payment was cancelled or declined at gateway', request, 'Verification API'); 
            throw new Error('Payment was cancelled or declined.'); 
        } 
        if (gatewayData.status !== 'success') throw new Error('Payment is still pending at the gateway.'); 
        
        const txUser = await User.findById(txCheck.user); 
        if (!txUser) throw { status: 404, message: 'Transaction user not found' }; 
        
        if (gatewayData.currency !== 'NGN') { 
            await failTransactionStrictly(txCheck._id, `SECURITY ALERT: Invalid currency (${gatewayData.currency})`, request, 'Verification API'); 
            throw new Error('SECURITY ALERT: Payment currency mismatch. Payment rejected.'); 
        } 
        if (!gatewayData.customer || gatewayData.customer.email !== txUser.email) { 
            await failTransactionStrictly(txCheck._id, `SECURITY ALERT: Email mismatch.`, request, 'Verification API'); 
            throw new Error('SECURITY ALERT: Customer email mismatch. Payment rejected.'); 
        } 
        
        const expectedTotalKobo = sanitizeAmount(Number(txCheck.amount) + Number(txCheck.fee)) * 100; 
        if (gatewayData.amount < expectedTotalKobo) { 
            await failTransactionStrictly(txCheck._id, 'Failed: Partial Payment Detected', request, 'Verification API'); 
            throw new Error('SECURITY ALERT: Payment amount mismatch.'); 
        } 
        
        const session = await mongoose.startSession(); 
        session.startTransaction(); 
        try { 
            const lockedTx = await Transaction.findOneAndUpdate( 
                { _id: txCheck._id, status: TX_STATUS.PENDING }, 
                { status: TX_STATUS.SUCCESS }, 
                { session, new: true } 
            ); 
            
            if (!lockedTx) { 
                await session.abortTransaction(); session.endSession(); 
                return reply.send({ success: true, message: 'Payment verified successfully.' }); 
            } 
            
            const creditAmount = sanitizeAmount(lockedTx.amount); 
            const updatedWallet = await Wallet.findOneAndUpdate( 
                { user: lockedTx.user }, { $inc: { availableBalance: creditAmount, balance: creditAmount } }, { session, new: true } 
            ); 
            
            lockedTx.balanceBefore = String(sanitizeAmount(Number(updatedWallet.availableBalance) - creditAmount)); 
            lockedTx.balanceAfter = String(updatedWallet.availableBalance); 
            await lockedTx.save({ session }); 
            
            await createAuditLog({ 
                user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: creditAmount, 
                type: 'funding', previousBalance: lockedTx.balanceBefore, newBalance: lockedTx.balanceAfter, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: TX_STATUS.SUCCESS, source: 'Verification API' 
            }, session); 
            
            await sendSystemNotification(lockedTx.user, 'Wallet Funded', `Your wallet has been successfully credited with ₦${creditAmount.toLocaleString()}. Ref: ${lockedTx.providerReference}`, 'funding', request, session); 
            
            await session.commitTransaction(); 
            session.endSession(); 
            
            if (request.server && request.server.io) request.server.io.to(`user:${lockedTx.user}`).emit('wallet:update', { balance: String(updatedWallet.availableBalance) }); 
            reply.send({ success: true, message: 'Payment verified and wallet credited!' }); 
        } catch (dbError) { 
            await session.abortTransaction(); session.endSession(); throw dbError; 
        } 
    } catch (error) { handleError(reply, error, 'Failed to verify payment.'); }
}

/* =========================================================================
   WITHDRAWAL (ATOMIC)
========================================================================= */
async function withdraw(request, reply) {
    try {
        const schema = Joi.object({ amount: Joi.number().min(100).required(), bankAccount: Joi.object().required(), pin: Joi.string().length(4).required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'withdraw')) throw new Error('Too Many Requests.');

        const existingTx = await checkIdempotency(request, 'withdrawal');
        if (existingTx) return reply.send({ success: true, message: 'Withdrawal already processing (Idempotency Cache).', transaction: existingTx });

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const withdrawAmount = sanitizeAmount(value.amount);
            const user = await User.findById(request.user._id); 
            const wallet = await Wallet.findOne({ user: request.user._id }); 
            if (!wallet) throw new Error('Wallet error.'); 
            if (wallet.isFrozen) throw new Error('Wallet is frozen. Please contact support.'); 
            
            await verifyAndHandlePin(user, wallet, value.pin); 
            await checkDailyLimit(request.user._id, 'withdrawal', withdrawAmount, config.limits?.dailyWithdrawal || 500000);
            
            const pendingWithdrawal = await Transaction.findOne({ user: request.user._id, type: 'withdrawal', status: TX_STATUS.PROCESSING }); 
            if (pendingWithdrawal) throw new Error('Duplicate Protection: You already have a withdrawal processing.'); 
            
            let transferFee = withdrawAmount > 50000 ? 50 : (withdrawAmount > 5000 ? 25 : 10);
            const totalDeduction = sanitizeAmount(withdrawAmount + transferFee); 
            
            const updatedWallet = await Wallet.findOneAndUpdate( 
                { user: request.user._id, availableBalance: { $gte: totalDeduction }, isFrozen: { $ne: true } }, 
                { $inc: { availableBalance: -totalDeduction, balance: -totalDeduction } }, 
                { session, new: true } 
            ); 
            
            if (!updatedWallet) throw new Error('Insufficient Funds or Wallet Locked.'); 
            
            // [2] & [27] BANK ACCOUNT DATA ENCRYPTION & MASKING
            const rawAccountNo = sanitizeText(value.bankAccount?.accountNumber || 'Unknown'); 
            const maskedAccountNo = rawAccountNo.length > 4 ? `****${rawAccountNo.slice(-4)}` : rawAccountNo; 
            const safeBankName = sanitizeText(value.bankAccount?.bankName || 'Bank').toUpperCase(); 
            const safeAccountName = sanitizeText(value.bankAccount?.accountName || 'Unknown');
            
            const secureProviderRef = `MANUAL_WTH_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; 
            const idempotencyKey = request.headers['x-idempotency-key'] || `wth_${Date.now()}`; 
            
            const transaction = new Transaction({ 
                user: request.user._id, type: 'withdrawal', description: `Withdrawal to ${safeBankName} - ${maskedAccountNo}`, 
                amount: withdrawAmount, fee: transferFee, totalDeduction: totalDeduction, 
                balanceBefore: String(sanitizeAmount(Number(updatedWallet.availableBalance) + totalDeduction)), 
                balanceAfter: String(updatedWallet.availableBalance), 
                status: TX_STATUS.PROCESSING, provider: PROVIDERS.INTERNAL, providerReference: secureProviderRef, 
                idempotencyKey: idempotencyKey, ipAddress: request.ip, userAgent: request.headers['user-agent'], 
                bankName: safeBankName, accountNumber: maskedAccountNo, accountName: safeAccountName, 
                metadata: { maskedAccountNo, encryptedData: encryptBankData(`${rawAccountNo}:${safeAccountName}`) } 
            }); 
            await transaction.save({ session }); 
            
            await createAuditLog({ 
                user: request.user._id, transactionId: transaction._id, reference: secureProviderRef, amount: totalDeduction, 
                type: 'withdrawal', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: TX_STATUS.PROCESSING, source: 'Withdrawal API' 
            }, session); 
            
            await sendSystemNotification(request.user._id, 'Withdrawal Submitted', `Your request to withdraw ₦${withdrawAmount.toLocaleString()} to ${safeBankName} is being processed. Ref: ${secureProviderRef}`, 'withdrawal', request, session); 
            
            await session.commitTransaction(); 
            session.endSession(); 
            
            if (request.server && request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(updatedWallet.availableBalance) }); 
            reply.send({ success: true, message: 'Withdrawal request submitted. Awaiting manual payout.', transaction }); 
        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'System error processing withdrawal.'); }
}

/* =========================================================================
   INTERNAL TRANSFER (ATOMIC)
========================================================================= */
async function transfer(request, reply) {
    try {
        const schema = Joi.object({ amount: Joi.number().min(100).required(), recipient: Joi.string().required(), pin: Joi.string().length(4).required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'transfer')) throw new Error('Too Many Requests.');

        const existingTx = await checkIdempotency(request, 'transfer');
        if (existingTx) return reply.send({ success: true, message: 'Transfer successful (Idempotency Cache).', transaction: existingTx });

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const transferAmount = sanitizeAmount(value.amount);
            const sender = await User.findById(request.user._id); 
            const senderWalletCheck = await Wallet.findOne({ user: request.user._id }); 
            if (senderWalletCheck.isFrozen) throw new Error('Your wallet is frozen.'); 
            
            await verifyAndHandlePin(sender, senderWalletCheck, value.pin); 
            await checkDailyLimit(request.user._id, 'transfer', transferAmount, config.limits?.dailyTransfer || 5000000);
            
            const sanitizedRecipient = sanitizeText(value.recipient);
            let query = { $or: [{ email: sanitizedRecipient.toLowerCase() }, { phoneNumber: sanitizedRecipient }] }; 
            if (mongoose.Types.ObjectId.isValid(sanitizedRecipient)) query.$or.push({ _id: sanitizedRecipient }); 
            
            const recipientUser = await User.findOne(query); 
            if (!recipientUser) throw new Error('Recipient NATERPAY ID not found'); 
            if (recipientUser._id.toString() === request.user._id.toString()) throw new Error('You cannot transfer to yourself'); 
            
            const recipientWalletCheck = await Wallet.findOne({ user: recipientUser._id }); 
            if (recipientWalletCheck.isFrozen) throw new Error('Recipient wallet is currently frozen.'); 
            
            const updatedSenderWallet = await Wallet.findOneAndUpdate( 
                { user: request.user._id, availableBalance: { $gte: transferAmount }, isFrozen: { $ne: true } }, 
                { $inc: { availableBalance: -transferAmount, balance: -transferAmount } }, 
                { session, new: true } 
            ); 
            if (!updatedSenderWallet) throw new Error('Insufficient balance or wallet locked.'); 
            
            const updatedRecipientWallet = await Wallet.findOneAndUpdate( 
                { user: recipientUser._id, isFrozen: { $ne: true } }, 
                { $inc: { availableBalance: transferAmount, balance: transferAmount } }, 
                { session, new: true } 
            ); 
            if (!updatedRecipientWallet) throw new Error('Critical Error: Failed to credit recipient.'); 
            
            const txRefOut = `TRF_OUT_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; 
            const txRefIn = `TRF_IN_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; 
            const idempotencyKey = request.headers['x-idempotency-key'] || `trf_${Date.now()}`; 
            
            // [14] DOUBLE-ENTRY LEDGER: Exact debit/credit pairing 
            const senderTransaction = new Transaction({ 
                user: request.user._id, type: 'transfer', description: `Transfer to ${recipientUser.name}`, 
                amount: transferAmount, fee: 0, balanceBefore: String(sanitizeAmount(Number(updatedSenderWallet.availableBalance) + transferAmount)), 
                balanceAfter: String(updatedSenderWallet.availableBalance), status: TX_STATUS.SUCCESS, provider: PROVIDERS.INTERNAL, 
                providerReference: txRefOut, idempotencyKey: idempotencyKey, ipAddress: request.ip, userAgent: request.headers['user-agent'] 
            }); 
            
            const recipientTransaction = new Transaction({ 
                user: recipientUser._id, type: 'transfer', description: `Received from ${sender.name}`, 
                amount: transferAmount, fee: 0, balanceBefore: String(sanitizeAmount(Number(updatedRecipientWallet.availableBalance) - transferAmount)), 
                balanceAfter: String(updatedRecipientWallet.availableBalance), status: TX_STATUS.SUCCESS, provider: PROVIDERS.INTERNAL, providerReference: txRefIn 
            }); 
            
            await senderTransaction.save({ session }); 
            await recipientTransaction.save({ session }); 
            
            await createAuditLog({ 
                user: request.user._id, transactionId: senderTransaction._id, reference: txRefOut, amount: transferAmount, 
                type: 'transfer_out', previousBalance: senderTransaction.balanceBefore, newBalance: senderTransaction.balanceAfter, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: TX_STATUS.SUCCESS, source: 'Transfer API' 
            }, session); 
            
            await createAuditLog({ 
                user: recipientUser._id, transactionId: recipientTransaction._id, reference: txRefIn, amount: transferAmount, 
                type: 'transfer_in', previousBalance: recipientTransaction.balanceBefore, newBalance: recipientTransaction.balanceAfter, 
                ipAddress: 'INTERNAL', userAgent: 'SYSTEM', status: TX_STATUS.SUCCESS, source: 'Transfer API' 
            }, session); 
            
            await sendSystemNotification(request.user._id, 'Transfer Sent', `You successfully sent ₦${transferAmount.toLocaleString()} to ${recipientUser.name}.`, 'transfer', request, session); 
            await sendSystemNotification(recipientUser._id, 'Money Received', `You received ₦${transferAmount.toLocaleString()} from ${sender.name}.`, 'deposit', request, session); 
            
            await session.commitTransaction(); 
            session.endSession(); 
            
            if (request.server && request.server.io) { 
                request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(updatedSenderWallet.availableBalance) }); 
                request.server.io.to(`user:${recipientUser._id}`).emit('wallet:update', { balance: String(updatedRecipientWallet.availableBalance) }); 
            } 
            
            reply.send({ success: true, message: 'Transfer successful', transaction: senderTransaction, recipientName: recipientUser.name }); 
        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'Failed to process transfer.'); }
}

/* =========================================================================
   MISC ROUTING
========================================================================= */
async function setPin(request, reply) {
    try {
        const schema = Joi.object({ pin: Joi.string().length(4).required(), confirmPin: Joi.string().valid(Joi.ref('pin')).required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'setpin')) throw new Error('Too Many Requests.');
        
        const user = await User.findById(request.user._id); 
        const wallet = await Wallet.findOne({ user: request.user._id }); 
        if (typeof wallet.setPin === 'function') await wallet.setPin(String(value.pin)); 
        
        const salt = await bcrypt.genSalt(10); 
        user.transactionPin = await bcrypt.hash(String(value.pin), salt); 
        user.isSecured = true; 
        user.failedPinAttempts = 0; 
        user.pinLockUntil = null; 
        await user.save(); 

        // [18] Audit Pin Change
        await createAuditLog({
            user: request.user._id, transactionId: null, reference: `PIN_${Date.now()}`, amount: 0,
            type: 'security_update', previousBalance: wallet.availableBalance, newBalance: wallet.availableBalance, 
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: TX_STATUS.SUCCESS, source: 'Settings API'
        });
        
        reply.send({ success: true, message: 'PIN set successfully' }); 
    } catch (error) { handleError(reply, error, 'Failed to set PIN'); }
}

async function resolveBankAccount(request, reply) {
    try {
        const schema = Joi.object({ accountNumber: Joi.string().required(), bankCode: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const response = await withRetry(() => axios.get(`${PAYSTACK_BASE_URL}/bank/resolve?account_number=${value.accountNumber}&bank_code=${value.bankCode}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, timeout: 10000
        }));
        reply.send({ success: true, accountName: response.data.data.account_name });
    } catch (error) { handleError(reply, error, 'Invalid Account Details.'); }
}

/* =========================================================================
   [15] SYSTEM HEALTH MONITORING
========================================================================= */
async function healthCheck(request, reply) {
    try {
        const dbStatus = mongoose.connection.readyState === 1 ? 'OK' : 'DOWN';
        const redisStatus = redisClient && redisClient.status === 'ready' ? 'OK' : 'UNAVAILABLE';
        reply.send({ success: true, status: 'Active', database: dbStatus, redis: redisStatus, timestamp: new Date() });
    } catch(e) { reply.status(500).send({ success: false, message: 'Health Check Failed' }); }
}

/* =========================================================================
   7. PAYSTACK WEBHOOK (ATOMIC & PROTECTED)
========================================================================= */
async function handlePaystackWebhook(request, reply) {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(request.body)).digest('hex');
        if (hash !== request.headers['x-paystack-signature']) return reply.status(401).send({ success: false, message: 'Invalid Signature' });

        if (request.body.event === 'charge.success') { 
            const gatewayData = request.body.data; 
            const reference = gatewayData.reference; 
            if (!reference) return reply.code(200).send('Ignored'); 

            // [9] Webhook Replay Timestamp Check
            const paidAt = gatewayData.paid_at ? new Date(gatewayData.paid_at).getTime() : Date.now();
            if (Date.now() - paidAt > 5 * 60 * 1000) return reply.code(200).send('Webhook expired/too old');

            // Webhook Replay Cache Check
            const eventId = gatewayData.id || reference;
            const cacheKey = `webhook_processed_${eventId}`;
            if (redisClient && redisClient.status === 'ready') {
                const exists = await redisClient.get(cacheKey);
                if (exists) return reply.code(200).send('Duplicate webhook ignored');
                await redisClient.set(cacheKey, '1', 'EX', 86400); 
            }
            
            const txCheck = await Transaction.findOne({ providerReference: reference }); 
            if (!txCheck || txCheck.status !== TX_STATUS.PENDING) return reply.code(200).send('Not pending or not found'); 
            
            const txUser = await User.findById(txCheck.user); 
            if (!txUser) return reply.code(200).send('User not found'); 
            
            if (gatewayData.currency !== 'NGN') { 
                await failTransactionStrictly(txCheck._id, `WEBHOOK ALERT: Invalid currency (${gatewayData.currency})`, request, 'Webhook API'); 
                return reply.code(200).send('Invalid Currency'); 
            } 
            
            if (!gatewayData.customer || gatewayData.customer.email !== txUser.email) { 
                await failTransactionStrictly(txCheck._id, `WEBHOOK ALERT: Email mismatch.`, request, 'Webhook API'); 
                return reply.code(200).send('Email Mismatch'); 
            } 
            
            const expectedTotalKobo = sanitizeAmount(Number(txCheck.amount) + Number(txCheck.fee)) * 100; 
            if (gatewayData.amount < expectedTotalKobo) { 
                await failTransactionStrictly(txCheck._id, 'Webhook Failed: Partial Payment', request, 'Webhook API'); 
                return reply.code(200).send('Amount mismatch'); 
            } 
            
            const session = await mongoose.startSession(); 
            session.startTransaction(); 
            try { 
                const lockedTx = await Transaction.findOneAndUpdate( 
                    { _id: txCheck._id, status: TX_STATUS.PENDING }, 
                    { status: TX_STATUS.SUCCESS }, 
                    { session, new: true } 
                ); 
                
                if (!lockedTx) { 
                    await session.abortTransaction(); 
                    session.endSession(); 
                    return reply.code(200).send('Already processed'); 
                } 
                
                const creditAmount = sanitizeAmount(lockedTx.amount); 
                const updatedWallet = await Wallet.findOneAndUpdate( 
                    { user: lockedTx.user }, 
                    { $inc: { availableBalance: creditAmount, balance: creditAmount } }, 
                    { session, new: true } 
                ); 
                
                lockedTx.balanceBefore = String(sanitizeAmount(Number(updatedWallet.availableBalance) - creditAmount)); 
                lockedTx.balanceAfter = String(updatedWallet.availableBalance); 
                await lockedTx.save({ session }); 
                
                await createAuditLog({ 
                    user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: creditAmount, 
                    type: 'funding', previousBalance: lockedTx.balanceBefore, newBalance: lockedTx.balanceAfter, 
                    ipAddress: 'PAYSTACK_WEBHOOK', userAgent: 'SYSTEM', status: TX_STATUS.SUCCESS, source: 'Webhook API' 
                }, session); 
                
                await sendSystemNotification(lockedTx.user, 'Wallet Funded', `Your wallet was successfully credited with ₦${creditAmount.toLocaleString()} via Paystack.`, 'funding', request, session); 
                
                await session.commitTransaction(); 
                session.endSession(); 
                
                if (request.server && request.server.io) { 
                    request.server.io.to(`user:${lockedTx.user}`).emit('wallet:update', { balance: String(updatedWallet.availableBalance) }); 
                } 
            } catch (dbError) { 
                await session.abortTransaction(); 
                session.endSession(); 
                throw dbError; 
            } 
        } 
        reply.code(200).send('Processed'); 
    } catch (error) {
        logger.error('Webhook Error', error);
        reply.code(500).send('Internal Server Error');
    }
}

module.exports = { 
    getWallet, fundWallet, verifyFunding, 
    fundManualWallet, adminApproveManualFunding, adminRejectManualFunding,
    withdraw, transfer, setPin, resolveBankAccount, handlePaystackWebhook, healthCheck 
};
