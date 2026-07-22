const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const config = require('../config');
const axios = require('axios');
const crypto = require('crypto');

// Dynamic Imports for Enterprise Modules
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
   [23] REDIS / DISTRIBUTED RATE LIMITING ENGINE
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

async function checkRateLimit(request, action) {
    const ip = request.ip;
    const userId = request.user ? request.user._id : 'anon';
    const limit = 5; // Strict 5 requests per minute
    const windowSeconds = 60;

    if (redisClient && redisClient.status === 'ready') {
        const ipKey = `rate:${action}:ip:${ip}`;
        const userKey = `rate:${action}:user:${userId}`;

        const [ipCount, userCount] = await Promise.all([
            redisClient.incr(ipKey),
            redisClient.incr(userKey)
        ]);

        if (ipCount === 1) await redisClient.expire(ipKey, windowSeconds);
        if (userCount === 1) await redisClient.expire(userKey, windowSeconds);

        if (ipCount > limit || userCount > limit) {
            console.warn(`[RATE LIMIT BLOCKED - REDIS] Action: ${action} | IP: ${ip} | User: ${userId} | Time: ${new Date().toISOString()}`);
            return false;
        }
        return true;
    } else {
        // Fallback gracefully to memory if Redis is down/unavailable
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

        const ipAllowed = checkKey(ipKey);
        const userAllowed = checkKey(userKey);

        if (!ipAllowed || !userAllowed) {
            console.warn(`[RATE LIMIT BLOCKED - MEMORY] Action: ${action} | IP: ${ip} | User: ${userId} | Time: ${new Date().toISOString()}`);
            return false;
        }
        return true;
    }
}

/* =========================================================================
   [20] IMMUTABLE AUDIT LOGGING ENGINE
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
        if (session) await log.save({ session });
        else await log.save();
    } catch(e) { console.error('Audit Log Error (Requires Immediate Admin Attention)', e); }
}

/* =========================================================================
   [21] IDEMPOTENCY ENFORCEMENT ENGINE
========================================================================= */
async function checkIdempotency(request, type) {
    const idemKey = request.headers['x-idempotency-key'];
    if (idemKey) {
        const existingTx = await Transaction.findOne({ idempotencyKey: idemKey, user: request.user._id, type });
        if (existingTx) {
            console.log(`[IDEMPOTENCY HIT] Type: ${type} | Key: ${idemKey} | User: ${request.user._id}`);
            return existingTx;
        }
    }
    return null;
}

/* =========================================================================
   [22] SYSTEM NOTIFICATION ENGINE
========================================================================= */
async function sendSystemNotification(user, title, message, type, request, session = null) {
    if (!Notification) return;
    try {
        const notif = new Notification({ user, title, message, type, isRead: false });
        if (session) await notif.save({ session });
        else await notif.save();
        if (request.server && request.server.io) {
            request.server.io.to(`user:${user}`).emit('notification:new', notif);
        }
    } catch(e) { console.error('Notification Engine Error', e); }
}

/* =========================================================================
   [26] STRICT STATE TRANSITION PROTECTION HELPER
========================================================================= */
async function failTransactionStrictly(txId, reason, request, source) {
    // Only allows PENDING -> FAILED
    const failedTx = await Transaction.findOneAndUpdate(
        { _id: txId, status: 'pending' },
        { $set: { status: 'failed', description: reason } },
        { new: true }
    );
    if (failedTx) {
        await createAuditLog({
            user: failedTx.user, transactionId: failedTx._id, reference: failedTx.providerReference, amount: failedTx.amount,
            type: failedTx.type, previousBalance: failedTx.balanceBefore || '0', newBalance: failedTx.balanceAfter || '0',
            ipAddress: request ? request.ip : 'SYSTEM', userAgent: request ? request.headers['user-agent'] : 'SYSTEM',
            status: 'failed', source: source
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
        
        throw new Error(failedAttempts >= 3 
            ? 'SECURITY ALERT: Maximum attempts reached. Transfers locked for 15 minutes.' 
            : `SECURITY ALERT: Incorrect PIN. ${3 - failedAttempts} attempts remaining.`);
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
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    reply.send({ success: true, wallet });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch wallet' }); }
}

/* =========================================================================
   2. INITIALIZE FUNDING
========================================================================= */
async function fundWallet(request, reply) {
  try {
    if (!await checkRateLimit(request, 'fund')) return reply.status(429).send({ success: false, message: 'Too Many Requests. Please try again later.' });

    const existingTx = await checkIdempotency(request, 'funding');
    if (existingTx) {
        return reply.send({ success: true, message: 'Payment already initialized (Idempotency Cache)', paymentReference: existingTx.providerReference, provider: 'paystack', checkoutUrl: existingTx.metadata?.checkoutUrl || '/dashboard.html' });
    }

    const { amount } = request.body;
    const requestedAmount = parseFloat(amount);
    const minFunding = config.business?.minFunding || 100;
    const maxFunding = config.business?.maxFunding || 10000000;

    if (!requestedAmount || requestedAmount < minFunding) return reply.status(400).send({ success: false, message: `Minimum funding amount is ₦${minFunding.toLocaleString()}` });
    if (requestedAmount > maxFunding) return reply.status(400).send({ success: false, message: `Maximum funding amount is ₦${maxFunding.toLocaleString()}` });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const user = await User.findById(request.user._id);
    if (!wallet || !user) return reply.status(404).send({ success: false, message: 'User or Wallet not found' });
    
    let gatewayFee = 0;
    if (requestedAmount < 2500) { gatewayFee = (requestedAmount * 0.015) / (1 - 0.015); } 
    else { gatewayFee = ((requestedAmount * 0.015) + 100) / (1 - 0.015); }
    if (gatewayFee > 2000) gatewayFee = 2000; 

    const totalToCharge = Math.ceil(requestedAmount + gatewayFee);
    const paymentReference = typeof generateTransactionReference === 'function' ? generateTransactionReference() : `FUND_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startBalance = String(wallet.availableBalance || 0);

    const idempotencyKey = request.headers['x-idempotency-key'] || `idem_${Date.now()}`;

    const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize',
      { email: user.email, amount: totalToCharge * 100, reference: paymentReference, callback_url: `${request.protocol}://${request.hostname}/dashboard.html` },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const checkoutUrl = paystackResponse.data.data.authorization_url;

    const transaction = new Transaction({
      user: request.user._id, type: 'funding', description: `Wallet funding via Paystack`,
      amount: requestedAmount, fee: Math.ceil(gatewayFee), balanceBefore: startBalance, balanceAfter: startBalance,
      status: 'pending', provider: 'paystack', providerReference: paymentReference,
      idempotencyKey: idempotencyKey, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      metadata: { checkoutUrl }
    });
    await transaction.save();

    await createAuditLog({
        user: request.user._id, transactionId: transaction._id, reference: paymentReference, amount: requestedAmount,
        type: 'funding', previousBalance: startBalance, newBalance: startBalance, ipAddress: request.ip,
        userAgent: request.headers['user-agent'], status: 'pending', source: 'Funding API'
    });

    reply.send({ success: true, message: 'Payment initialized', paymentReference, checkoutUrl, provider: 'paystack' });
  } catch (error) { 
      reply.status(500).send({ success: false, message: 'Failed to initiate payment gateway.' }); 
  }
}

/* =========================================================================
   3. VERIFY FUNDING (ATOMIC)
========================================================================= */
async function verifyFunding(request, reply) {
  try {
    if (!await checkRateLimit(request, 'verify')) return reply.status(429).send({ success: false, message: 'Too Many Requests.' });

    const { reference } = request.body;
    if (!reference) return reply.status(400).send({ success: false, message: 'Payment reference is required' });
    
    const txCheck = await Transaction.findOne({ providerReference: reference });
    if (!txCheck) return reply.status(404).send({ success: false, message: 'Transaction not found' });
    
    // [26] Strict State Protection: Ensure we don't process non-pending states
    if (txCheck.status === 'success') return reply.send({ success: true, message: 'Wallet already credited' });
    if (txCheck.status === 'failed') return reply.status(400).send({ success: false, message: 'Transaction was cancelled or declined.' });

    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    const gatewayData = response.data.data; 
    
    if (gatewayData.status === 'abandoned' || gatewayData.status === 'failed') {
        await failTransactionStrictly(txCheck._id, 'Payment was cancelled or declined at gateway', request, 'Verification API');
        return reply.status(400).send({ success: false, message: 'Payment was cancelled or declined.' });
    }
    if (gatewayData.status !== 'success') {
        return reply.status(400).send({ success: false, message: 'Payment is still pending at the gateway.' });
    }

    const txUser = await User.findById(txCheck.user);
    if (!txUser) return reply.status(404).send({ success: false, message: 'Transaction user not found' });

    // [25] CURRENCY VALIDATION
    if (gatewayData.currency !== 'NGN') {
        await failTransactionStrictly(txCheck._id, `SECURITY ALERT: Invalid currency (${gatewayData.currency})`, request, 'Verification API');
        return reply.status(400).send({ success: false, message: 'SECURITY ALERT: Payment currency mismatch. Payment rejected.' });
    }

    // [24] CUSTOMER OWNERSHIP VERIFICATION
    if (!gatewayData.customer || gatewayData.customer.email !== txUser.email) {
        await failTransactionStrictly(txCheck._id, `SECURITY ALERT: Email mismatch. Expected: ${txUser.email}, Got: ${gatewayData.customer?.email}`, request, 'Verification API');
        return reply.status(400).send({ success: false, message: 'SECURITY ALERT: Customer email mismatch. Payment rejected.' });
    }

    const expectedTotalKobo = (Number(txCheck.amount) + Number(txCheck.fee)) * 100;
    if (gatewayData.amount < expectedTotalKobo) {
        await failTransactionStrictly(txCheck._id, 'Failed: Partial Payment Detected', request, 'Verification API');
        return reply.status(400).send({ success: false, message: 'SECURITY ALERT: Payment amount mismatch.' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        // [26] ATOMIC STRICT PENDING -> SUCCESS LOCK
        const lockedTx = await Transaction.findOneAndUpdate(
            { _id: txCheck._id, status: 'pending' },
            { status: 'success' },
            { session, new: true }
        );
        
        if (!lockedTx) {
            await session.abortTransaction();
            session.endSession();
            return reply.send({ success: true, message: 'Payment verified successfully.' });
        }

        const creditAmount = Number(lockedTx.amount);
        const updatedWallet = await Wallet.findOneAndUpdate(
            { user: lockedTx.user },
            { $inc: { availableBalance: creditAmount, balance: creditAmount } },
            { session, new: true }
        );

        lockedTx.balanceBefore = String(Number(updatedWallet.availableBalance) - creditAmount);
        lockedTx.balanceAfter = String(updatedWallet.availableBalance);
        await lockedTx.save({ session });

        await createAuditLog({
            user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: creditAmount,
            type: 'funding', previousBalance: lockedTx.balanceBefore, newBalance: lockedTx.balanceAfter, 
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Verification API'
        }, session);

        await sendSystemNotification(lockedTx.user, 'Wallet Funded', `Your wallet has been successfully credited with ₦${creditAmount.toLocaleString()}. Ref: ${lockedTx.providerReference}`, 'funding', request, session);

        await session.commitTransaction();
        session.endSession();

        if (request.server && request.server.io) {
            request.server.io.to(`user:${lockedTx.user}`).emit('wallet:update', { balance: String(updatedWallet.availableBalance) });
        }
        reply.send({ success: true, message: 'Payment verified and wallet credited!' });

    } catch (dbError) {
        await session.abortTransaction();
        session.endSession();
        throw dbError;
    }
  } catch (error) { 
      reply.status(500).send({ success: false, message: 'Failed to verify payment.' }); 
  }
}

/* =========================================================================
   4. WITHDRAWAL (ATOMIC)
========================================================================= */
async function withdraw(request, reply) {
  if (!await checkRateLimit(request, 'withdraw')) return reply.status(429).send({ success: false, message: 'Too Many Requests.' });

  const existingTx = await checkIdempotency(request, 'withdrawal');
  if (existingTx) return reply.send({ success: true, message: 'Withdrawal already processing (Idempotency Cache).', transaction: existingTx });

  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { amount, bankAccount, pin } = request.body;
    const withdrawAmount = parseFloat(amount);
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!wallet) throw new Error('Wallet error.');
    if (wallet.isFrozen) throw new Error('Wallet is frozen. Please contact support.');
    
    await verifyAndHandlePin(user, wallet, pin);

    const pendingWithdrawal = await Transaction.findOne({ user: request.user._id, type: 'withdrawal', status: 'processing' });
    if (pendingWithdrawal) throw new Error('Duplicate Protection: You already have a withdrawal processing.');

    let transferFee = 10; 
    if (withdrawAmount > 5000 && withdrawAmount <= 50000) transferFee = 25;
    else if (withdrawAmount > 50000) transferFee = 50;
    
    const totalDeduction = withdrawAmount + transferFee;

    const updatedWallet = await Wallet.findOneAndUpdate(
        { user: request.user._id, availableBalance: { $gte: totalDeduction }, isFrozen: { $ne: true } },
        { $inc: { availableBalance: -totalDeduction, balance: -totalDeduction } },
        { session, new: true }
    );

    if (!updatedWallet) throw new Error('Insufficient Funds or Wallet Locked.');

    // [27] BANK ACCOUNT DATA PROTECTION (Masking)
    const rawAccountNo = String(bankAccount?.accountNumber || 'Unknown');
    const maskedAccountNo = rawAccountNo.length > 4 ? `****${rawAccountNo.slice(-4)}` : rawAccountNo;
    const safeBankName = String(bankAccount?.bankName || 'Bank').toUpperCase();
    
    const secureProviderRef = `MANUAL_WTH_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const idempotencyKey = request.headers['x-idempotency-key'] || `wth_${Date.now()}`;

    const transaction = new Transaction({
      user: request.user._id, type: 'withdrawal', description: `Withdrawal to ${safeBankName} - ${maskedAccountNo}`,
      amount: withdrawAmount, fee: transferFee, totalDeduction: totalDeduction, 
      balanceBefore: String(Number(updatedWallet.availableBalance) + totalDeduction), 
      balanceAfter: String(updatedWallet.availableBalance),
      status: 'processing', provider: 'internal', providerReference: secureProviderRef,
      idempotencyKey: idempotencyKey, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      bankName: safeBankName, accountNumber: maskedAccountNo, accountName: bankAccount?.accountName || 'Unknown', 
      metadata: { maskedAccountNo, rawEncrypted: 'Requires Implementation Layer' } 
    });
    
    await transaction.save({ session });

    await createAuditLog({
        user: request.user._id, transactionId: transaction._id, reference: secureProviderRef, amount: totalDeduction,
        type: 'withdrawal', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, 
        ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'processing', source: 'Withdrawal API'
    }, session);

    await sendSystemNotification(request.user._id, 'Withdrawal Submitted', `Your request to withdraw ₦${withdrawAmount.toLocaleString()} to ${safeBankName} is being processed. Ref: ${secureProviderRef}`, 'withdrawal', request, session);

    await session.commitTransaction();
    session.endSession();

    if (request.server && request.server.io) {
        request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(updatedWallet.availableBalance) });
    }

    reply.send({ success: true, message: 'Withdrawal request submitted. Awaiting manual payout.', transaction });
  } catch (error) { 
      await session.abortTransaction();
      session.endSession();
      reply.status(400).send({ success: false, message: error.message || 'System error processing transfer.' }); 
  }
}

/* =========================================================================
   5. INTERNAL TRANSFER (ATOMIC)
========================================================================= */
async function transfer(request, reply) {
  if (!await checkRateLimit(request, 'transfer')) return reply.status(429).send({ success: false, message: 'Too Many Requests.' });

  const existingTx = await checkIdempotency(request, 'transfer');
  if (existingTx) return reply.send({ success: true, message: 'Transfer successful (Idempotency Cache).', transaction: existingTx });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, recipient, pin } = request.body; 
    const transferAmount = parseFloat(amount);
    if (!transferAmount || transferAmount < 100) throw new Error('Minimum transfer amount is ₦100');
    
    const sender = await User.findById(request.user._id);
    const senderWalletCheck = await Wallet.findOne({ user: request.user._id });
    if (senderWalletCheck.isFrozen) throw new Error('Your wallet is frozen.');
    
    await verifyAndHandlePin(sender, senderWalletCheck, pin);

    let query = { $or: [{ email: String(recipient).toLowerCase() }, { phoneNumber: String(recipient) }] };
    if (mongoose.Types.ObjectId.isValid(recipient)) query.$or.push({ _id: recipient });

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

    const senderTransaction = new Transaction({
      user: request.user._id, type: 'transfer', description: `Transfer to ${recipientUser.name}`,
      amount: transferAmount, fee: 0, 
      balanceBefore: String(Number(updatedSenderWallet.availableBalance) + transferAmount), 
      balanceAfter: String(updatedSenderWallet.availableBalance),
      status: 'success', provider: 'internal', providerReference: txRefOut, idempotencyKey: idempotencyKey,
      ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    const recipientTransaction = new Transaction({
      user: recipientUser._id, type: 'transfer', description: `Received from ${sender.name}`,
      amount: transferAmount, fee: 0, 
      balanceBefore: String(Number(updatedRecipientWallet.availableBalance) - transferAmount), 
      balanceAfter: String(updatedRecipientWallet.availableBalance),
      status: 'success', provider: 'internal', providerReference: txRefIn
    });
    
    await senderTransaction.save({ session });
    await recipientTransaction.save({ session });

    await createAuditLog({
        user: request.user._id, transactionId: senderTransaction._id, reference: txRefOut, amount: transferAmount,
        type: 'transfer_out', previousBalance: senderTransaction.balanceBefore, newBalance: senderTransaction.balanceAfter, 
        ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Transfer API'
    }, session);

    await createAuditLog({
        user: recipientUser._id, transactionId: recipientTransaction._id, reference: txRefIn, amount: transferAmount,
        type: 'transfer_in', previousBalance: recipientTransaction.balanceBefore, newBalance: recipientTransaction.balanceAfter, 
        ipAddress: 'INTERNAL', userAgent: 'SYSTEM', status: 'success', source: 'Transfer API'
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
  } catch (error) { 
      await session.abortTransaction();
      session.endSession();
      reply.status(400).send({ success: false, message: error.message || 'Failed to process transfer.' }); 
  }
}

/* =========================================================================
   6. MISC ROUTING
========================================================================= */
async function setPin(request, reply) {
  try {
    if (!await checkRateLimit(request, 'setpin')) return reply.status(429).send({ success: false, message: 'Too Many Requests.' });

    const { pin, confirmPin } = request.body;
    if (!pin || String(pin).length !== 4) return reply.status(400).send({ success: false, message: 'PIN must be 4 digits' });
    if (String(pin) !== String(confirmPin)) return reply.status(400).send({ success: false, message: 'PINs do not match' });
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (typeof wallet.setPin === 'function') await wallet.setPin(String(pin));
    
    const salt = await bcrypt.genSalt(10);
    user.transactionPin = await bcrypt.hash(String(pin), salt);
    user.isSecured = true;
    user.failedPinAttempts = 0;
    user.pinLockUntil = null;
    await user.save();
    reply.send({ success: true, message: 'PIN set successfully' });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to set PIN' }); }
}

async function resolveBankAccount(request, reply) {
    try {
        const { accountNumber, bankCode } = request.body;
        const response = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });
        reply.send({ success: true, accountName: response.data.data.account_name });
    } catch (error) { reply.status(400).send({ success: false, message: 'Invalid Account Details.' }); }
}

/* =========================================================================
   7. PAYSTACK WEBHOOK (ATOMIC)
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

            const txCheck = await Transaction.findOne({ providerReference: reference });
            if (!txCheck || txCheck.status !== 'pending') return reply.code(200).send('Not pending or not found');

            const txUser = await User.findById(txCheck.user);
            if (!txUser) return reply.code(200).send('User not found');

            // [25] CURRENCY VALIDATION
            if (gatewayData.currency !== 'NGN') {
                await failTransactionStrictly(txCheck._id, `WEBHOOK ALERT: Invalid currency (${gatewayData.currency})`, request, 'Webhook API');
                return reply.code(200).send('Invalid Currency');
            }

            // [24] CUSTOMER OWNERSHIP VERIFICATION
            if (!gatewayData.customer || gatewayData.customer.email !== txUser.email) {
                await failTransactionStrictly(txCheck._id, `WEBHOOK ALERT: Email mismatch.`, request, 'Webhook API');
                return reply.code(200).send('Email Mismatch');
            }

            const expectedTotalKobo = (Number(txCheck.amount) + Number(txCheck.fee)) * 100;
            if (gatewayData.amount < expectedTotalKobo) {
                await failTransactionStrictly(txCheck._id, 'Webhook Failed: Partial Payment', request, 'Webhook API');
                return reply.code(200).send('Amount mismatch');
            }

            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                // [26] STRICT STATE TRANSITION
                const lockedTx = await Transaction.findOneAndUpdate(
                    { _id: txCheck._id, status: 'pending' },
                    { status: 'success' },
                    { session, new: true }
                );
                
                if (!lockedTx) {
                    await session.abortTransaction();
                    session.endSession();
                    return reply.code(200).send('Already processed');
                }

                const creditAmount = Number(lockedTx.amount);
                const updatedWallet = await Wallet.findOneAndUpdate(
                    { user: lockedTx.user },
                    { $inc: { availableBalance: creditAmount, balance: creditAmount } },
                    { session, new: true }
                );

                lockedTx.balanceBefore = String(Number(updatedWallet.availableBalance) - creditAmount);
                lockedTx.balanceAfter = String(updatedWallet.availableBalance);
                await lockedTx.save({ session });

                await createAuditLog({
                    user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: creditAmount,
                    type: 'funding', previousBalance: lockedTx.balanceBefore, newBalance: lockedTx.balanceAfter, 
                    ipAddress: 'PAYSTACK_WEBHOOK', userAgent: 'SYSTEM', status: 'success', source: 'Webhook API'
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
        reply.code(500).send('Internal Server Error'); 
    }
}

module.exports = { getWallet, fundWallet, verifyFunding, withdraw, transfer, setPin, resolveBankAccount, handlePaystackWebhook };
