const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const config = require('../config');
const axios = require('axios');
const crypto = require('crypto'); 

let AuditLog, Notification, generateIdempotencyKey, generateTransactionReference;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { 
    const authUtils = require('../utils/auth');
    generateIdempotencyKey = authUtils.generateIdempotencyKey;
    generateTransactionReference = authUtils.generateTransactionReference;
} catch(e) {}

/**
 * 1. Get Wallet
 */
async function getWallet(request, reply) {
  try {
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    reply.send({ success: true, wallet });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to fetch wallet' });
  }
}

/**
 * 2. Initiate Wallet Funding
 */
async function fundWallet(request, reply) {
  try {
    const { amount, provider } = request.body;
    const paymentProvider = String(provider || 'paystack').toLowerCase();
    const requestedAmount = parseFloat(amount);
    
    const minFunding = config.business?.minFunding || 100;
    const maxFunding = config.business?.maxFunding || 10000000;

    if (!requestedAmount || requestedAmount < minFunding) {
      return reply.status(400).send({ success: false, message: `Minimum funding amount is ₦${minFunding.toLocaleString()}` });
    }
    if (requestedAmount > maxFunding) {
      return reply.status(400).send({ success: false, message: `Maximum funding amount is ₦${maxFunding.toLocaleString()}` });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const user = await User.findById(request.user._id);
    if (!wallet || !user) return reply.status(404).send({ success: false, message: 'User or Wallet not found' });
    
    let gatewayFee = 0;
    if (paymentProvider === 'paystack') {
        if (requestedAmount < 2500) {
            gatewayFee = (requestedAmount * 0.015) / (1 - 0.015);
        } else {
            gatewayFee = ((requestedAmount * 0.015) + 100) / (1 - 0.015);
        }
        if (gatewayFee > 2000) gatewayFee = 2000; 
    }

    const totalToCharge = Math.ceil(requestedAmount + gatewayFee);
    const paymentReference = typeof generateTransactionReference === 'function' ? generateTransactionReference() : `FUND_${Date.now()}`;
    const startBalance = String(wallet.availableBalance || 0);

    const transaction = new Transaction({
      user: request.user._id, type: 'funding', description: `Wallet funding via ${paymentProvider}`,
      amount: requestedAmount, fee: Math.ceil(gatewayFee), balanceBefore: startBalance, balanceAfter: startBalance,
      status: 'pending', provider: paymentProvider, providerReference: paymentReference,
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `idem_${Date.now()}`, 
      ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save();
    
    let checkoutUrl = '';
    
    if (paymentProvider === 'paystack') {
      const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize',
        { 
            email: user.email, 
            amount: totalToCharge * 100, 
            reference: paymentReference, 
            callback_url: `${request.protocol}://${request.hostname}/dashboard.html` 
        },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
      );
      checkoutUrl = paystackResponse.data.data.authorization_url;
    } else if (paymentProvider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${encodedKeys}` } });
      const accessToken = authResponse.data.responseBody.accessToken;

      const initResponse = await axios.post(`${baseUrl}/api/v1/merchant/transactions/init-transaction`,
        { amount: totalToCharge, customerName: user.name, customerEmail: user.email, paymentReference: paymentReference, paymentDescription: 'NATERPAY Wallet Funding', currencyCode: 'NGN', contractCode: process.env.MONNIFY_CONTRACT_CODE, redirectUrl: `${request.protocol}://${request.hostname}/dashboard.html` },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      checkoutUrl = initResponse.data.responseBody.checkoutUrl;
    } else {
      return reply.status(400).send({ success: false, message: 'Unsupported payment provider' });
    }
    
    reply.send({ success: true, message: 'Payment initialized', paymentReference, checkoutUrl, provider: paymentProvider });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to initiate payment gateway.' });
  }
}

/**
 * 3. Verify Wallet Funding
 */
async function verifyFunding(request, reply) {
  try {
    const { reference } = request.body;
    if (!reference) return reply.status(400).send({ success: false, message: 'Payment reference is required' });
    
    const transaction = await Transaction.findOne({ providerReference: reference });
    if (!transaction) return reply.status(404).send({ success: false, message: 'Transaction not found' });
    
    if (transaction.status === 'success') return reply.send({ success: true, message: 'Wallet already credited' });
    if (transaction.status === 'failed') return reply.status(400).send({ success: false, message: 'Transaction was cancelled or declined.' });

    let gatewayStatus = 'pending';

    if (transaction.provider === 'paystack') {
      const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { 
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } 
      });
      gatewayStatus = response.data.data.status; 
    } 
    else if (transaction.provider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${encodedKeys}` } });
      const accessToken = authResponse.data.responseBody.accessToken;
      
      const response = await axios.get(`${baseUrl}/api/v1/merchant/transactions/query?paymentReference=${reference}`, { 
          headers: { Authorization: `Bearer ${accessToken}` } 
      });
      
      const monnifyStatus = response.data.responseBody.paymentStatus;
      if (monnifyStatus === 'PAID') gatewayStatus = 'success';
      else if (monnifyStatus === 'FAILED' || monnifyStatus === 'CANCELLED' || monnifyStatus === 'EXPIRED') gatewayStatus = 'failed';
    }

    if (gatewayStatus === 'abandoned' || gatewayStatus === 'failed') {
        transaction.status = 'failed';
        transaction.metadata = transaction.metadata || {};
        transaction.metadata.reason = 'User abandoned checkout or bank declined.';
        await transaction.save();
        return reply.status(400).send({ success: false, message: 'Payment was cancelled or declined. Marked as failed in ledger.' });
    }

    if (gatewayStatus !== 'success') {
        return reply.status(400).send({ success: false, message: 'Payment is still pending at the gateway. Awaiting settlement.' });
    }

    const wallet = await Wallet.findOne({ user: transaction.user });
    
    const creditAmount = transaction.amount; 

    wallet.availableBalance = String(parseFloat(wallet.availableBalance || 0) + creditAmount);
    wallet.balance = String(parseFloat(wallet.balance || 0) + creditAmount);
    await wallet.save();
    
    transaction.status = 'success';
    transaction.balanceAfter = String(wallet.availableBalance || 0);
    await transaction.save();
    
    if (Notification && typeof Notification.create === 'function') {
        await Notification.create({ user: transaction.user, title: 'Wallet Funded', message: `Your wallet was credited with ₦${creditAmount.toLocaleString()}`, type: 'transaction', priority: 'high' }).catch(() => {});
    }
    if (request.server && request.server.io) {
        request.server.io.to(`user:${transaction.user}`).emit('wallet:update', { balance: String(wallet.availableBalance || 0) });
    }
    
    reply.send({ success: true, message: 'Payment verified and wallet credited!' });

  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to verify payment. Network error.' });
  }
}

/**
 * 4. Withdraw Engine (ENTERPRISE RULES APPLIED & BUGS FIXED)
 */
async function withdraw(request, reply) {
  try {
    const { amount, bankAccount, pin, otp } = request.body;
    const withdrawAmount = parseFloat(amount);
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet error.' });
    if (wallet.isFrozen) return reply.status(403).send({ success: false, message: 'Wallet is frozen. Please contact support.' });
    
    // === THE FIX: Look for 'processing' instead of 'pending' ===
    const pendingWithdrawal = await Transaction.findOne({ user: request.user._id, type: 'withdrawal', status: 'processing' });
    if (pendingWithdrawal) {
        return reply.status(400).send({ success: false, message: 'Duplicate Protection: You already have a pending withdrawal request. Please wait for it to be processed.' });
    }

    // --- ENTERPRISE RULE: KYC WITHDRAWAL LIMITS ---
    const kycLevel = user.kycLevel || 0;
    let maxKycLimit = 10000; // Tier 0 (Unverified)
    if (kycLevel === 1) maxKycLimit = 50000;   // Tier 1
    if (kycLevel >= 2) maxKycLimit = 500000;   // Tier 2 & 3
    
    if (withdrawAmount > maxKycLimit) {
        return reply.status(400).send({ success: false, message: `Your current verification (Tier ${kycLevel}) limits you to ₦${maxKycLimit.toLocaleString()} per withdrawal. Please upgrade your KYC.` });
    }

    // --- BUG FIX 1: DAILY WITHDRAWAL MATH RESOLVED ---
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const dailyTxs = await Transaction.find({ user: request.user._id, type: 'withdrawal', createdAt: { $gte: startOfDay }, status: { $ne: 'failed' } });
    
    const dailyCount = dailyTxs.length;
    
    // Using parseFloat to ensure JS does mathematical addition, NOT string concatenation
    const dailyVolume = dailyTxs.reduce((sum, tx) => {
        const txAmount = parseFloat(tx.amount?.toString() || 0);
        return sum + txAmount;
    }, 0);

    const maxDailyCount = config.business?.maxDailyWithdrawals || 5;
    const maxDailyVolume = config.business?.maxDailyWithdrawalVolume || 1000000;

    if (dailyCount >= maxDailyCount) {
        return reply.status(400).send({ success: false, message: `Enterprise Policy: Daily withdrawal limit of ${maxDailyCount} transactions reached.` });
    }
    if (dailyVolume + withdrawAmount > maxDailyVolume) {
        return reply.status(400).send({ success: false, message: `Enterprise Policy: This exceeds your daily withdrawal limit of ₦${maxDailyVolume.toLocaleString()}.` });
    }

    // --- ENTERPRISE RULE: HIGH VALUE OTP SECURITY ---
    const otpThreshold = config.business?.otpThreshold || 50000;
    if (withdrawAmount >= otpThreshold && config.business?.requireHighValueOtp) {
        if (!otp) return reply.status(400).send({ success: false, message: `Withdrawals of ₦${otpThreshold.toLocaleString()} and above require OTP verification.` });
    }

    // PIN Authentication
    if (!pin) return reply.status(400).send({ success: false, message: 'Security PIN is required' });
    let isPinValid = false;
    if (typeof wallet.verifyPin === 'function') {
        isPinValid = await wallet.verifyPin(String(pin));
    } else if (user.transactionPin) {
        isPinValid = await bcrypt.compare(String(pin), user.transactionPin);
    } else {
        return reply.status(400).send({ success: false, message: 'Please setup your withdrawal PIN in settings first.' });
    }
    if (!isPinValid) return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Withdrawal PIN.' });

    // --- ENTERPRISE RULE: CONFIGURABLE PRICING ENGINE ---
    let transferFee = 10; 
    if (config.business?.flatWithdrawalFee) {
        transferFee = config.business.flatWithdrawalFee;
    } else {
        if (withdrawAmount > 5000 && withdrawAmount <= 50000) transferFee = 25;
        else if (withdrawAmount > 50000) transferFee = 50;
    }
    
    const totalDeduction = withdrawAmount + transferFee;
    const currentAvail = parseFloat(wallet.availableBalance || 0);
    
    if (currentAvail < totalDeduction) {
      return reply.status(400).send({ success: false, message: `Insufficient Funds. You need ₦${totalDeduction.toLocaleString()} including the ₦${transferFee} processing fee.` });
    }
    
    // Deduct user wallet
    wallet.availableBalance = String(currentAvail - totalDeduction);
    wallet.balance = String(parseFloat(wallet.balance || 0) - totalDeduction);
    await wallet.save();
    
    const safeBankName = String(bankAccount?.bankName || 'Bank').toUpperCase();
    const safeAccountNo = String(bankAccount?.accountNumber || 'Unknown');

    // === CRITICAL BUG FIX: ISOLATING WITHDRAWALS FROM WEBHOOKS ===
    const secureProviderRef = `MANUAL_WTH_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const transaction = new Transaction({
      user: request.user._id, 
      type: 'withdrawal', 
      description: `Withdrawal to ${safeBankName} - ${safeAccountNo}`,
      amount: withdrawAmount, 
      fee: transferFee, 
      totalDeduction: totalDeduction, 
      balanceBefore: String(currentAvail), 
      balanceAfter: String(wallet.availableBalance || 0),
      // === THE FIX: Set to 'processing' instead of 'pending' to shield from cron scripts ===
      status: 'processing', 
      // =====================================================================================
      provider: 'internal', 
      providerReference: secureProviderRef, 
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `wth_${Date.now()}`, 
      ipAddress: request.ip, 
      userAgent: request.headers['user-agent'],
      bankName: bankAccount?.bankName || safeBankName,
      accountNumber: bankAccount?.accountNumber || safeAccountNo,
      accountName: bankAccount?.accountName || 'Unknown',
      metadata: { bankAccount }
    });
    
    await transaction.save();
    
    // --- ENTERPRISE RULE: REAL-TIME ADMIN NOTIFICATIONS ---
    try {
        if (request.server && request.server.io) {
            const admins = await User.find({ role: { $in: ['admin', 'superadmin'] } });
            admins.forEach(adm => {
                request.server.io.to(`user:${adm._id}`).emit('notification', { 
                    type: 'warning', 
                    title: 'New Withdrawal Alert', 
                    message: `${user.name} requested ₦${withdrawAmount.toLocaleString()}` 
                });
            });
            // Update User Wallet
            request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(wallet.availableBalance || 0) });
        }
    } catch(e) {} // Fail silently if socket disconnects
    
    reply.send({ success: true, message: 'Withdrawal request submitted. Awaiting manual payout.', transaction });
  } catch (error) {
    reply.status(500).send({ success: false, message: error.message || 'System error processing transfer.' });
  }
}

/**
 * 5. Peer-to-Peer Transfer (STRICTLY FREE)
 */
async function transfer(request, reply) {
  try {
    const { amount, recipient, pin } = request.body; 
    const transferAmount = parseFloat(amount);
    
    if (!transferAmount || transferAmount < 100) return reply.status(400).send({ success: false, message: 'Minimum transfer amount is ₦100' });
    
    const senderWallet = await Wallet.findOne({ user: request.user._id });
    const sender = await User.findById(request.user._id);

    if (!pin) return reply.status(400).send({ success: false, message: 'PIN entry is required.' });
    
    let isPinValid = false;
    if (typeof senderWallet.verifyPin === 'function') {
        isPinValid = await senderWallet.verifyPin(String(pin));
    } else if (sender.transactionPin) {
        isPinValid = await bcrypt.compare(String(pin), sender.transactionPin);
    } else {
        return reply.status(400).send({ success: false, message: 'Please setup your transfer PIN in settings first.' });
    }

    if (!isPinValid) return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Transfer PIN.' });

    const currentAvail = parseFloat(senderWallet.availableBalance || 0);
    if (currentAvail < transferAmount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    
    let query = { $or: [{ email: String(recipient).toLowerCase() }, { phoneNumber: String(recipient) }] };
    if (require('mongoose').Types.ObjectId.isValid(recipient)) query.$or.push({ _id: recipient });

    const recipientUser = await User.findOne(query);
    if (!recipientUser) return reply.status(404).send({ success: false, message: 'Recipient NATERPAY ID not found' });
    if (recipientUser._id.toString() === request.user._id.toString()) return reply.status(400).send({ success: false, message: 'You cannot transfer to yourself' });
    
    const recipientWallet = await Wallet.findOne({ user: recipientUser._id });
    if (!recipientWallet) return reply.status(404).send({ success: false, message: 'Recipient wallet not configured' });

    senderWallet.availableBalance = String(currentAvail - transferAmount);
    senderWallet.balance = String(parseFloat(senderWallet.balance || 0) - transferAmount);
    await senderWallet.save();
    
    recipientWallet.availableBalance = String(parseFloat(recipientWallet.availableBalance || 0) + transferAmount);
    recipientWallet.balance = String(parseFloat(recipientWallet.balance || 0) + transferAmount);
    await recipientWallet.save();
    
    // Adding secure references to peer-to-peer transfers
    const senderTransaction = new Transaction({
      user: request.user._id, type: 'transfer', description: `Transfer to ${recipientUser.name}`,
      amount: transferAmount, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(senderWallet.availableBalance || 0),
      status: 'success', provider: 'internal', providerReference: `TRF_OUT_${Date.now()}`
    });
    
    const recipientTransaction = new Transaction({
      user: recipientUser._id, type: 'transfer', description: `Received from ${sender.name}`,
      amount: transferAmount, fee: 0, 
      balanceBefore: String(parseFloat(recipientWallet.availableBalance || 0) - transferAmount), 
      balanceAfter: String(recipientWallet.availableBalance || 0),
      status: 'success', provider: 'internal', providerReference: `TRF_IN_${Date.now()}`
    });
    
    await senderTransaction.save();
    await recipientTransaction.save();
    
    if (request.server && request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(senderWallet.availableBalance || 0) });
      request.server.io.to(`user:${recipientUser._id}`).emit('wallet:update', { balance: String(recipientWallet.availableBalance || 0) });
      request.server.io.to(`user:${recipientUser._id}`).emit('notification', { title: 'Funds Received', message: `₦${transferAmount.toLocaleString()} received from ${sender.name}` });
    }
    
    reply.send({ success: true, message: 'Transfer successful', transaction: senderTransaction, recipientName: recipientUser.name });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to process transfer.' });
  }
}

/**
 * 6. Set PIN
 */
async function setPin(request, reply) {
  try {
    const { pin, confirmPin } = request.body;
    if (!pin || String(pin).length !== 4) return reply.status(400).send({ success: false, message: 'PIN must be 4 digits' });
    if (String(pin) !== String(confirmPin)) return reply.status(400).send({ success: false, message: 'PINs do not match' });
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!user || !wallet) return reply.status(404).send({ success: false, message: 'Account not found' });
    
    if (typeof wallet.setPin === 'function') {
        await wallet.setPin(String(pin));
    } 
    const salt = await bcrypt.genSalt(10);
    user.transactionPin = await bcrypt.hash(String(pin), salt);
    user.isSecured = true;
    await user.save();
    
    reply.send({ success: true, message: 'PIN set successfully' });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to set PIN' });
  }
}

/**
 * 7. Resolve Bank Account
 */
async function resolveBankAccount(request, reply) {
    try {
        const { accountNumber, bankCode } = request.body;
        if (!accountNumber || !bankCode) {
            return reply.status(400).send({ success: false, message: 'Account Number and Bank Code required' });
        }
        const response = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });
        reply.send({ success: true, accountName: response.data.data.account_name });
    } catch (error) {
        reply.status(400).send({ success: false, message: 'Invalid Account Details.' });
    }
}

/**
 * 8. PAYSTACK SECURE WEBHOOK (BUG FIXED: IGNORES EMPTY REFERENCES)
 */
async function handlePaystackWebhook(request, reply) {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(request.body)).digest('hex');

        if (hash !== request.headers['x-paystack-signature']) {
            return reply.status(401).send({ success: false, message: 'Invalid Signature - Unauthorized Access' });
        }

        const event = request.body;

        if (event.event === 'charge.success') {
            const data = event.data;
            const reference = data.reference;
            
            // SECURITY LOCK: Do not process empty references
            if (!reference) return reply.code(200).send('Webhook ignored: No reference provided');

            const existingTx = await Transaction.findOne({ providerReference: reference, status: 'success' });
            if (existingTx) return reply.code(200).send('Transaction already processed');

            const pendingTx = await Transaction.findOne({ providerReference: reference, status: 'pending' });
            if (!pendingTx) return reply.code(200).send('Pending transaction record not found');

            const wallet = await Wallet.findOne({ user: pendingTx.user });
            if (!wallet) return reply.code(200).send('Wallet not found');

            const creditAmount = pendingTx.amount;
            const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
            
            wallet.availableBalance = String(currentAvail + creditAmount);
            wallet.balance = String(parseFloat(wallet.balance?.toString() || '0') + creditAmount);
            await wallet.save();

            pendingTx.status = 'success';
            pendingTx.balanceBefore = String(currentAvail);
            pendingTx.balanceAfter = wallet.availableBalance;
            await pendingTx.save();

            if (request.server && request.server.io) {
                request.server.io.to(`user:${pendingTx.user}`).emit('wallet:update', { balance: wallet.availableBalance });
                request.server.io.to(`user:${pendingTx.user}`).emit('notification', { 
                    type: 'success', 
                    title: 'Deposit Successful', 
                    message: `Your wallet has been funded with ₦${creditAmount.toLocaleString()}` 
                });
            }
        }
        reply.code(200).send('Webhook Processed');
    } catch (error) {
        reply.code(500).send('Internal Server Error');
    }
}

module.exports = { getWallet, fundWallet, verifyFunding, withdraw, transfer, setPin, resolveBankAccount, handlePaystackWebhook };
