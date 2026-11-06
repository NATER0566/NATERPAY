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

// [1] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg })),
        warn: (msg) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg })),
        error: (msg, err) => {
            const safeErr = err?.response?.data?.message || err?.message || String(err);
            console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: safeErr }));
        }
    };
}

const APP_URL = config.appUrl || process.env.APP_URL || 'https://naterpay-yrf7.onrender.com';

// UPDATE: Switch to v4 API Base URL
const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v4';

const TX_STATUS = { PENDING: 'pending', PROCESSING: 'processing', SUCCESS: 'success', FAILED: 'failed' };

let AuditLog, Notification, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

/* =========================================================================
   [2] CENTRALIZED ERROR HANDLING
========================================================================= */
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    
    let safeMessage = error.message || defaultMessage;
    // V4 returns structured errors: error.response.data.error.message
    if (error.response?.data?.error?.message) {
        safeMessage = error.response.data.error.message;
    } else if (error.response?.data?.message) {
        safeMessage = error.response.data.message;
    }
    
    logger.error(defaultMessage, safeMessage);
    return reply.status(error.status || 400).send({ success: false, message: safeMessage });
}

/* =========================================================================
   [3] DATA SANITIZERS & [4] REDIS ENGINE (Unchanged)
========================================================================= */
const parseDecimal = (val) => {
    if (val === null || val === undefined) return 0;
    if (val.$numberDecimal) return Number(val.$numberDecimal);
    if (typeof val === 'object' && typeof val.toString === 'function') return Number(val.toString());
    return Number(val) || 0;
};

const sanitizeAmount = (amount) => {
    let val = amount;
    if (val && typeof val === 'object' && val.toString) val = val.toString();
    const num = Number(parseFloat(val).toFixed(2));
    if (isNaN(num) || num <= 0) throw new Error('Invalid monetary amount.');
    return num;
};

const sanitizeText = (str) => {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim().substring(0, 255);
};

async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1 || (err.response && err.response.status >= 400 && err.response.status < 500)) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
}

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
    const limit = 10; 
    const windowSeconds = 60;

    if (redisClient && redisClient.status === 'ready') {
        try {
            const userKey = `rate:${action}:user:${userId}`;
            const count = await redisClient.incr(userKey);
            if (count === 1) await redisClient.expire(userKey, windowSeconds);
            return count <= limit;
        } catch (err) { return true; }
    }
    return true;
}

async function checkDailyLimit(userId, type, amount, limit) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const txs = await Transaction.aggregate([
        { $match: { user: userId, type: type, status: { $in: [TX_STATUS.SUCCESS, TX_STATUS.PENDING, TX_STATUS.PROCESSING] }, createdAt: {$gte: startOfDay } } },
        { $group: { _id: null, total: {$sum: { $toDouble: "$amount" } } } }
    ]);
    const totalToday = txs.length > 0 ? txs[0].total : 0;
    if (totalToday + amount > limit) throw new Error(`Daily ${type} limit of ₦${limit.toLocaleString()} exceeded.`);
}

async function createAuditLog(params, session = null) {
    if (!AuditLog) return;
    try {
        const log = new AuditLog({
            user: params.user, transactionId: params.transactionId, transactionReference: params.reference,
            amount: params.amount, type: params.type, previousBalance: String(params.previousBalance || '0'),
            newBalance: String(params.newBalance || '0'), ipAddress: params.ipAddress || 'SYSTEM', userAgent: params.userAgent || 'SYSTEM',
            status: params.status, source: params.source || 'API', details: params.details || {}
        });
        if (session) await log.save({ session, validateBeforeSave: false }); 
        else await log.save({ validateBeforeSave: false });
    } catch(e) { logger.error('Audit Log Error', e.message); }
}

async function checkIdempotency(request, type) {
    const idemKey = request.headers['x-idempotency-key'];
    if (idemKey) {
        const existingTx = await Transaction.findOne({ idempotencyKey: idemKey, user: request.user._id, type });
        if (existingTx) return existingTx;
    }
    return null;
}

async function sendSystemNotification(user, title, message, type, request, session = null) {
    if (!Notification) return;
    try {
        const notif = new Notification({ user, title, message: sanitizeText(message), type, isRead: false });
        if (session) await notif.save({ session }); else await notif.save();
        if (request.server && request.server.io) request.server.io.to(`user:${user}`).emit('notification:new', notif);
    } catch(e) { logger.error('Notification Engine Error', e.message); }
}

async function failTransactionStrictly(txId, reason, request, source) {
    const failedTx = await Transaction.findOneAndUpdate(
        { _id: txId, status: { $in: [TX_STATUS.PENDING, TX_STATUS.PROCESSING] } },
        { $set: { status: TX_STATUS.FAILED, description: sanitizeText(reason) } },
        { new: true }
    );
    if (failedTx) {
        await createAuditLog({
            user: failedTx.user, transactionId: failedTx._id, reference: failedTx.providerReference, amount: parseDecimal(failedTx.amount),
            type: failedTx.type, previousBalance: failedTx.balanceBefore || '0', newBalance: failedTx.balanceAfter || '0',
            ipAddress: request ? request.ip : 'SYSTEM', userAgent: request ? request.headers['user-agent'] : 'SYSTEM',
            status: TX_STATUS.FAILED, source: source
        });
    }
    return failedTx;
}

async function verifyAndHandlePin(user, wallet, providedPin) {
    if (user.pinLockUntil && user.pinLockUntil > new Date()) throw new Error(`Security Lock: PIN blocked until ${user.pinLockUntil.toLocaleTimeString()}.`);
    let isPinValid = false; 
    if (typeof wallet.verifyPin === 'function') isPinValid = await wallet.verifyPin(String(providedPin)); 
    else if (user.transactionPin) isPinValid = await bcrypt.compare(String(providedPin), user.transactionPin); 
    else throw new Error('Please setup your withdrawal PIN in settings first.'); 
    
    if (!isPinValid) { 
        const failedAttempts = (user.failedPinAttempts || 0) + 1; 
        let updateDoc = { failedPinAttempts: failedAttempts }; 
        if (failedAttempts >= 3) { updateDoc.pinLockUntil = new Date(Date.now() + 15 * 60000); updateDoc.failedPinAttempts = 0; } 
        await User.updateOne({ _id: user._id }, { $set: updateDoc }); 
        throw new Error(failedAttempts >= 3 ? 'SECURITY ALERT: Maximum attempts reached. Transfers locked for 15 minutes.' : `SECURITY ALERT: Incorrect PIN. ${3 - failedAttempts} attempts remaining.`); 
    } 
    if (user.failedPinAttempts > 0) await User.updateOne({ _id: user._id }, { $set: { failedPinAttempts: 0, pinLockUntil: null } }); 
    return true; 
}

/* =========================================================================
   1. GET WALLET & V4 VIRTUAL ACCOUNT GENERATOR
========================================================================= */
async function getWallet(request, reply) {
    try {
        let wallet = await Wallet.findOne({ user: request.user._id });
        if (!wallet) throw new Error('Wallet not found');

        if (!wallet.virtualAccount || !wallet.virtualAccount.accountNumber) {
            try {
                const user = await User.findById(request.user._id);
                // V4 uses FLW_CLIENT_SECRET
                if (user && process.env.FLW_CLIENT_SECRET) {
                    const fullName = user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Naterpay User';
                    const txRef = `VA_${user._id}_${Date.now()}`;
                    
                    // V4 specific payload structure
                    const payload = {
                        reference: txRef,
                        customer: {
                            email: user.email,
                            firstname: user.firstName || fullName.split(' ')[0] || 'User',
                            lastname: user.lastName || fullName.split(' ')[1] || 'Naterpay',
                            bvn: user.bvn || "22222222222",
                        },
                        amount: 0,
                        currency: 'NGN',
                        account_type: 'static'
                    };

                    const flwRes = await axios.post(`${FLUTTERWAVE_BASE_URL}/virtual-accounts`, payload, {
                        headers: {
                            'Authorization': `Bearer ${process.env.FLW_CLIENT_SECRET}`,
                            'Content-Type': 'application/json',
                            'X-Idempotency-Key': crypto.randomUUID()
                        }
                    });

                    if (flwRes.data && flwRes.data.status === 'success') {
                        wallet.virtualAccount = {
                            bankName: flwRes.data.data.bank_name,
                            accountNumber: flwRes.data.data.account_number,
                            accountName: `NATERPAY - ${fullName}`.substring(0, 50),
                            accountReference: flwRes.data.data.reference || txRef
                        };
                        await wallet.save();
                    }
                }
            } catch (flwErr) {
                logger.error('Flutterwave V4 Auto-Generation Error', flwErr.response?.data || flwErr.message);
            }
        }

        reply.send({ success: true, wallet });
    } catch (error) { handleError(reply, error, 'Failed to fetch wallet'); }
}

/* =========================================================================
   2. INITIALIZE FUNDING (FLUTTERWAVE V4) 
========================================================================= */
async function fundWallet(request, reply) {
    try {
        const schema = Joi.object({ 
            amount: Joi.number().min(100).required(), 
            currency: Joi.string().default('NGN'),
            method: Joi.string().optional() 
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw { status: 400, message: error.details[0].message };

        if (!await checkRateLimit(request, 'fund_init')) throw { status: 429, message: 'Too many funding attempts.' };

        // Ensure we are checking for the V4 Secret Client Credentials
        const rawKey = process.env.FLW_CLIENT_SECRET;
        if (!rawKey) {
            throw new Error('Server configuration error: FLW_CLIENT_SECRET gateway key missing.');
        }
        const trimmedKey = rawKey.trim();

        const amount = sanitizeAmount(value.amount);
        let fee = amount < 2500 ? (amount * 0.015) / (1 - 0.015) : ((amount * 0.015) + 100) / (1 - 0.015);
        if (fee > 2000) fee = 2000;
        fee = Math.ceil(fee);
        const totalCharge = amount + fee;

        const txReference = 'TX_FND_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex').toUpperCase();

        const wallet = await Wallet.findOne({ user: request.user._id });
        if (!wallet) throw new Error("Wallet not found");
        const startBalance = wallet.availableBalance ? wallet.availableBalance.toString() : '0';

        const redirectUrl = `${request.protocol}://${request.hostname}/fund.html`; 
        
        let flwRes;
        try {
            // V4 Payment Orchestrator Payload
            flwRes = await axios.post(`${FLUTTERWAVE_BASE_URL}/payments/initialize`, {
                reference: txReference,
                amount: totalCharge,
                currency: value.currency || 'NGN',
                redirect_url: redirectUrl,
                customer: {
                    email: request.user.email,
                    name: request.user.name || 'Naterpay User'
                },
                customizations: {
                    title: "NATER-PAY Wallet Funding",
                    description: "Fund your wallet securely"
                },
                metadata: { userId: request.user._id.toString(), type: 'wallet_fund', amount: amount, fee: fee }
            }, {
                headers: { 
                    Authorization: `Bearer ${trimmedKey}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': crypto.randomUUID()
                },
                timeout: 12000 
            });
        } catch (gatewayError) {
            const exactError = gatewayError.response?.data?.error?.message || gatewayError.message || 'Flutterwave gateway connection error.';
            logger.error(`[FW V4 REJECTED] Message: ${exactError}`);
            throw new Error(`Gateway Error: ${exactError}`);
        }

        const transaction = new Transaction({
            user: request.user._id, type: 'funding', description: 'Wallet Funding via Flutterwave',
            amount: amount, fee: fee, status: 'pending', provider: 'flutterwave', providerReference: txReference,
            balanceBefore: startBalance, balanceAfter: startBalance
        });
        await transaction.save({ validateBeforeSave: false });

        reply.send({ success: true, paymentReference: txReference, checkoutUrl: flwRes.data.data.checkout_url });
    } catch (error) { handleError(reply, error, 'Failed to initialize payment'); }
}

/* =========================================================================
   3 & 4 & 5. MANUAL FUNDING (Internal flows unchanged)
========================================================================= */
async function fundManualWallet(request, reply) { /* ... same implementation ... */ }
async function adminApproveManualFunding(request, reply) { /* ... same implementation ... */ }
async function adminRejectManualFunding(request, reply) { /* ... same implementation ... */ }

/* =========================================================================
   6. VERIFY FUNDING (FLUTTERWAVE V4)
========================================================================= */
async function verifyFunding(request, reply) {
    try {
        const schema = Joi.object({ reference: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw { status: 400, message: 'Reference is required.' };

        if (!await checkRateLimit(request, 'verify')) throw new Error('Too Many Requests.');
        
        const txCheck = await Transaction.findOne({ providerReference: value.reference }); 
        if (!txCheck) throw { status: 404, message: 'Transaction not found' }; 
        if (txCheck.status === TX_STATUS.SUCCESS) return reply.send({ success: true, message: 'Wallet already credited' }); 
        if (txCheck.status === TX_STATUS.FAILED) throw new Error('Transaction was cancelled or declined.'); 
        
        // V4 Verification Route
        const response = await withRetry(() => axios.get(`${FLUTTERWAVE_BASE_URL}/transactions/verify?reference=${value.reference}`, { 
            headers: { Authorization: `Bearer ${process.env.FLW_CLIENT_SECRET}` }, timeout: 15000 
        })); 
        const gatewayData = response.data.data; 
        
        if (gatewayData.status !== 'successful') { 
            txCheck.status = TX_STATUS.FAILED; txCheck.description = 'Payment was cancelled or failed at gateway.';
            await txCheck.save({ validateBeforeSave: false });
            throw new Error('Payment was cancelled or declined.'); 
        } 
        
        const txUser = await User.findById(txCheck.user); 
        const session = await mongoose.startSession(); 
        session.startTransaction(); 
        try { 
            const lockedTx = await Transaction.findOneAndUpdate({ _id: txCheck._id, status: TX_STATUS.PENDING }, { status: TX_STATUS.SUCCESS }, { session, new: true }); 
            if (!lockedTx) { await session.abortTransaction(); session.endSession(); return reply.send({ success: true, message: 'Payment verified successfully.' }); } 
            
            const amountVal = parseDecimal(lockedTx.amount);
            const feeVal = parseDecimal(lockedTx.fee);
            const expectedTotal = amountVal + feeVal;

            if (gatewayData.amount < expectedTotal) { 
                await session.abortTransaction(); session.endSession();
                await failTransactionStrictly(txCheck._id, 'Failed: Partial Payment Detected', request, 'Verification API'); 
                throw new Error('SECURITY ALERT: Payment amount mismatch.'); 
            }

            const creditAmount = sanitizeAmount(amountVal); 
            const updatedWallet = await Wallet.findOneAndUpdate({ user: lockedTx.user }, { $inc: { availableBalance: creditAmount, balance: creditAmount } }, { session, new: true }); 
            
            const currentBalance = parseDecimal(updatedWallet.availableBalance);
            
            lockedTx.balanceBefore = String(sanitizeAmount(currentBalance - creditAmount)); 
            lockedTx.balanceAfter = String(currentBalance); 
            await lockedTx.save({ session, validateBeforeSave: false }); 
            
            await session.commitTransaction(); session.endSession(); 
            if (request.server && request.server.io) request.server.io.to(`user:${lockedTx.user}`).emit('wallet:update', { balance: String(currentBalance) }); 
            reply.send({ success: true, message: 'Payment verified and wallet credited!' }); 
        } catch (dbError) { await session.abortTransaction(); session.endSession(); throw dbError; } 
    } catch (error) { handleError(reply, error, 'Failed to verify payment.'); }
}

/* =========================================================================
   7 & 8 & 9. WITHDRAWAL, TRANSFER, SET PIN (Internal Flow)
========================================================================= */
async function withdraw(request, reply) { /* ... same implementation ... */ }
async function transfer(request, reply) { /* ... same implementation ... */ }
async function setPin(request, reply) { /* ... same implementation ... */ }

/* =========================================================================
   10. RESOLVE BANK ACCOUNT (FLUTTERWAVE V4)
========================================================================= */
async function resolveBankAccount(request, reply) {
    try {
        const schema = Joi.object({ accountNumber: Joi.string().required(), bankCode: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const response = await withRetry(() => axios.post(`${FLUTTERWAVE_BASE_URL}/accounts/resolve`, {
            account_number: value.accountNumber,
            bank_code: value.bankCode // Updated to v4 parameter standard
        }, {
            headers: { Authorization: `Bearer ${process.env.FLW_CLIENT_SECRET}` }, timeout: 10000
        }));
        
        reply.send({ success: true, accountName: response.data.data.account_name });
    } catch (error) { handleError(reply, error, 'Invalid Account Details.'); }
}

/* =========================================================================
   11. FLUTTERWAVE WEBHOOK (REPLACES PAYSTACK & KORAPAY)
========================================================================= */
async function handleFlutterwaveWebhook(request, reply) {
    try {
        const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
        const signature = request.headers['verif-hash'];
        
        if (!signature || signature !== secretHash) {
            logger.warn('Flutterwave Webhook Signature Mismatch');
            return reply.status(401).send({ success: false, message: 'Invalid Signature' });
        }

        const payload = request.body;
        reply.code(200).send({ status: 'received' });

        // V4 Webhook structure check
        if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
            const gatewayData = payload.data;
            const reference = gatewayData.reference || gatewayData.tx_ref; // Fallback for v4/v3 compatibility during transition

            const cacheKey = `webhook_flw_processed_${gatewayData.id}`;
            if (redisClient && redisClient.status === 'ready') {
                const exists = await redisClient.get(cacheKey);
                if (exists) return;
                await redisClient.set(cacheKey, '1', 'EX', 86400); 
            }
            
            let txCheck = await Transaction.findOne({ providerReference: reference }); 

            if (!txCheck) {
                const txUser = await User.findOne({ email: gatewayData.customer.email });
                if (!txUser) return;

                const amountPaid = parseFloat(gatewayData.amount);
                const fee = parseFloat(gatewayData.fee || 0); // V4 uses fee instead of app_fee
                const netAmount = sanitizeAmount(amountPaid - fee);

                if (netAmount <= 0) return;

                const session = await mongoose.startSession();
                session.startTransaction();
                try {
                    const wallet = await Wallet.findOne({ user: txUser._id }).session(session);
                    const currentBalance = parseDecimal(wallet.availableBalance);
                    
                    const updatedWallet = await Wallet.findOneAndUpdate(
                        { user: txUser._id },
                        { $inc: { availableBalance: netAmount, balance: netAmount } },
                        { session, new: true }
                    );

                    const newBalance = parseDecimal(updatedWallet.availableBalance);

                    const newTx = new Transaction({
                        user: txUser._id, type: 'funding', description: `Bank Transfer Deposit`,
                        amount: netAmount, fee: fee, balanceBefore: String(currentBalance), balanceAfter: String(newBalance),
                        status: TX_STATUS.SUCCESS, provider: 'flutterwave', providerReference: reference,
                        ipAddress: 'FLUTTERWAVE_WEBHOOK', userAgent: 'SYSTEM'
                    });

                    await newTx.save({ session, validateBeforeSave: false });

                    await createAuditLog({
                        user: txUser._id, transactionId: newTx._id, reference: reference, amount: netAmount,
                        type: 'funding', previousBalance: currentBalance, newBalance: newBalance,
                        ipAddress: 'FLUTTERWAVE_WEBHOOK', status: TX_STATUS.SUCCESS, source: 'Flutterwave API'
                    }, session);

                    await sendSystemNotification(txUser._id, 'Bank Deposit Received', `Your wallet was automatically credited with ₦${netAmount.toLocaleString()} from your virtual account.`, 'funding', { server: request.server }, session);

                    await session.commitTransaction();
                    session.endSession();

                    if (request.server && request.server.io) {
                        request.server.io.to(`user:${txUser._id}`).emit('wallet:update', { balance: String(newBalance) });
                    }
                } catch (err) {
                    await session.abortTransaction();
                    session.endSession();
                }
                return;
            }

            if (txCheck.status !== TX_STATUS.PENDING) return;

            const amountVal = parseDecimal(txCheck.amount);
            const feeVal = parseDecimal(txCheck.fee);
            const expectedTotal = amountVal + feeVal;

            if (gatewayData.amount < expectedTotal) { 
                await failTransactionStrictly(txCheck._id, 'Webhook Failed: Partial Payment', request, 'Webhook API'); 
                return; 
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
                    return; 
                } 
                
                const creditAmount = sanitizeAmount(amountVal); 
                const updatedWallet = await Wallet.findOneAndUpdate( 
                    { user: lockedTx.user }, 
                    { $inc: { availableBalance: creditAmount, balance: creditAmount } }, 
                    { session, new: true } 
                ); 
                
                const currentBalance = parseDecimal(updatedWallet.availableBalance);

                lockedTx.balanceBefore = String(sanitizeAmount(currentBalance - creditAmount)); 
                lockedTx.balanceAfter = String(currentBalance); 
                await lockedTx.save({ session, validateBeforeSave: false }); 
                
                await createAuditLog({ 
                    user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: creditAmount, 
                    type: 'funding', previousBalance: lockedTx.balanceBefore, newBalance: lockedTx.balanceAfter, 
                    ipAddress: 'FLUTTERWAVE_WEBHOOK', userAgent: 'SYSTEM', status: TX_STATUS.SUCCESS, source: 'Webhook API' 
                }, session); 
                
                await sendSystemNotification(lockedTx.user, 'Wallet Funded', `Your wallet was successfully credited with ₦${creditAmount.toLocaleString()}.`, 'funding', request, session); 
                
                await session.commitTransaction(); 
                session.endSession(); 
                
                if (request.server && request.server.io) { 
                    request.server.io.to(`user:${lockedTx.user}`).emit('wallet:update', { balance: String(currentBalance) }); 
                } 
            } catch (dbError) { 
                await session.abortTransaction(); 
                session.endSession(); 
                throw dbError; 
            }
        }
    } catch (error) {
        logger.error('Webhook Error', error.message);
    }
}

/* =========================================================================
   12. HEALTH CHECK
========================================================================= */
async function healthCheck(request, reply) {
    try {
        const dbStatus = mongoose.connection.readyState === 1 ? 'OK' : 'DOWN';
        const redisStatus = redisClient && redisClient.status === 'ready' ? 'OK' : 'UNAVAILABLE';
        reply.send({ success: true, status: 'Active', database: dbStatus, redis: redisStatus, timestamp: new Date() });
    } catch(e) { reply.status(500).send({ success: false, message: 'Health Check Failed' }); }
}

module.exports = { 
    getWallet, fundWallet, verifyFunding, 
    fundManualWallet, adminApproveManualFunding, adminRejectManualFunding,
    withdraw, transfer, setPin, resolveBankAccount, handleFlutterwaveWebhook, healthCheck 
};
