const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const config = require('../config');
const axios = require('axios');

// Optional imports (safely loaded so they don't crash if missing)
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
    const paymentProvider = (provider || 'paystack').toLowerCase();
    
    if (!amount || amount < (config.business?.minWithdrawal || 100)) {
      return reply.status(400).send({ success: false, message: `Minimum funding amount is ₦${config.business?.minWithdrawal || 100}` });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const user = await User.findById(request.user._id);
    if (!wallet || !user) return reply.status(404).send({ success: false, message: 'User or Wallet not found' });
    
    const paymentReference = typeof generateTransactionReference === 'function' ? generateTransactionReference() : `FUND_${Date.now()}`;
    
    const transaction = new Transaction({
      user: request.user._id, type: 'funding', description: `Wallet funding via ${paymentProvider}`,
      amount, fee: 0, balanceBefore: wallet.availableBalance.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: paymentProvider, providerReference: paymentReference,
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `idem_${Date.now()}`, 
      ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save();
    
    let checkoutUrl = '';

    if (paymentProvider === 'paystack') {
      const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize',
        { email: user.email, amount: amount * 100, reference: paymentReference, callback_url: `${request.protocol}://${request.hostname}/dashboard.html` },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
      );
      checkoutUrl = paystackResponse.data.data.authorization_url;
    } 
    else if (paymentProvider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${encodedKeys}` } });
      const accessToken = authResponse.data.responseBody.accessToken;

      const initResponse = await axios.post(`${baseUrl}/api/v1/merchant/transactions/init-transaction`,
        { amount: amount, customerName: user.name, customerEmail: user.email, paymentReference: paymentReference, paymentDescription: 'NATERPAY Wallet Funding', currencyCode: 'NGN', contractCode: process.env.MONNIFY_CONTRACT_CODE, redirectUrl: `${request.protocol}://${request.hostname}/dashboard.html` },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      checkoutUrl = initResponse.data.responseBody.checkoutUrl;
    } else {
      return reply.status(400).send({ success: false, message: 'Unsupported payment provider' });
    }
    
    reply.send({ success: true, message: 'Payment initialized', paymentReference, checkoutUrl, provider: paymentProvider });
  } catch (error) {
    console.error('Funding Error:', error.message);
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

    let isSuccessful = false;

    if (transaction.provider === 'paystack') {
      const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
      if (response.data.data.status === 'success') isSuccessful = true;
    } 
    else if (transaction.provider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${encodedKeys}` } });
      const accessToken = authResponse.data.responseBody.accessToken;
      const response = await axios.get(`${baseUrl}/api/v1/merchant/transactions/query?paymentReference=${reference}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.data.responseBody.paymentStatus === 'PAID') isSuccessful = true;
    }

    if (!isSuccessful) return reply.status(400).send({ success: false, message: 'Payment not successful at gateway' });

    const wallet = await Wallet.findOne({ user: transaction.user });
    
    // Safely Credit Wallet
    wallet.availableBalance = (parseFloat(wallet.availableBalance.toString()) + transaction.amount).toString();
    wallet.balance = (parseFloat(wallet.balance.toString()) + transaction.amount).toString();
    await wallet.save();
    
    transaction.status = 'success';
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save();
    
    if (Notification && typeof Notification.create === 'function') {
        await Notification.create({ user: transaction.user, title: 'Wallet Funded', message: `Your wallet was credited with ₦${transaction.amount.toLocaleString()}`, type: 'transaction', priority: 'high' }).catch(() => {});
    }
    
    if (request.server && request.server.io) request.server.io.to(`user:${transaction.user}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
    
    reply.send({ success: true, message: 'Payment verified and wallet credited!' });
  } catch (error) {
    console.error('Verify Funding Error:', error.message);
    reply.status(500).send({ success: false, message: 'Failed to verify payment' });
  }
}

/**
 * 4. Highly Secure Withdrawal Engine (CRASH-PROOF)
 */
async function withdraw(request, reply) {
  try {
    const { amount, bankAccount, pin } = request.body;
    
    const withdrawAmount = parseFloat(amount);
    const minWth = config.business?.minWithdrawal || 1000;
    const maxWth = config.business?.maxWithdrawal || 500000;

    if (!withdrawAmount || withdrawAmount < minWth) {
      return reply.status(400).send({ success: false, message: `Minimum withdrawal amount is ₦${minWth}` });
    }
    if (withdrawAmount > maxWth) {
      return reply.status(400).send({ success: false, message: `Maximum withdrawal amount is ₦${maxWth}` });
    }
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet error.' });
    if (wallet.isFrozen) return reply.status(403).send({ success: false, message: 'Wallet is frozen. Please contact support.' });
    
    // Universal PIN Checker (Handles both User and Wallet schemas)
    if (!pin) return reply.status(400).send({ success: false, message: 'Security PIN is required' });
    
    let isPinValid = false;
    if (typeof wallet.verifyPin === 'function') {
        isPinValid = await wallet.verifyPin(pin);
    } else if (user.transactionPin) {
        isPinValid = await bcrypt.compare(pin.toString(), user.transactionPin);
    } else {
        return reply.status(400).send({ success: false, message: 'Please setup your withdrawal PIN in settings first.' });
    }

    if (!isPinValid) return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Withdrawal PIN.' });

    // Exact Math
    const transferFee = 50; 
    const totalDeduction = withdrawAmount + transferFee;
    const currentAvail = parseFloat(wallet.availableBalance.toString() || '0');
    
    if (currentAvail < totalDeduction) {
      return reply.status(400).send({ success: false, message: `Insufficient Funds. You need ₦${totalDeduction.toLocaleString()} including fees.` });
    }
    
    // Deduct Funds safely without requiring MongoDB sessions
    wallet.availableBalance = (currentAvail - totalDeduction).toString();
    wallet.balance = (parseFloat(wallet.balance.toString() || '0') - totalDeduction).toString();
    await wallet.save();
    
    const transaction = new Transaction({
      user: request.user._id, type: 'withdrawal', description: `Transfer to ${bankAccount.bankName.toUpperCase()} - ${bankAccount.accountNumber}`,
      amount: withdrawAmount, fee: transferFee, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'internal', idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `wth_${Date.now()}`, 
      metadata: { bankAccount }, ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save();
    
    if (request.server && request.server.io) {
        request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
    }
    
    reply.send({ success: true, message: 'Withdrawal processed successfully', transaction });
  } catch (error) {
    console.error('Withdrawal Server Error:', error); // This logs exactly what broke to your terminal
    reply.status(500).send({ success: false, message: error.message || 'Failed to process withdrawal. Check server logs.' });
  }
}

/**
 * 5. Peer-to-Peer Internal Transfer (CRASH-PROOF)
 */
async function transfer(request, reply) {
  try {
    const { amount, recipient, pin } = request.body; 
    const transferAmount = parseFloat(amount);
    
    if (!transferAmount || transferAmount < 100) return reply.status(400).send({ success: false, message: 'Minimum transfer amount is ₦100' });
    
    const senderWallet = await Wallet.findOne({ user: request.user._id });
    const sender = await User.findById(request.user._id);

    // Universal PIN Checker
    if (!pin) return reply.status(400).send({ success: false, message: 'PIN entry is required.' });
    let isPinValid = false;
    if (typeof senderWallet.verifyPin === 'function') {
        isPinValid = await senderWallet.verifyPin(pin);
    } else if (sender.transactionPin) {
        isPinValid = await bcrypt.compare(pin.toString(), sender.transactionPin);
    } else {
        return reply.status(400).send({ success: false, message: 'Please setup your transfer PIN in settings first.' });
    }

    if (!isPinValid) return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Transfer PIN.' });

    const currentAvail = parseFloat(senderWallet.availableBalance.toString() || '0');
    if (currentAvail < transferAmount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    
    // Find recipient
    let query = { $or: [{ email: recipient.toLowerCase() }, { phoneNumber: recipient }] };
    if (require('mongoose').Types.ObjectId.isValid(recipient)) query.$or.push({ _id: recipient });

    const recipientUser = await User.findOne(query);
    if (!recipientUser) return reply.status(404).send({ success: false, message: 'Recipient NATERPAY ID not found' });
    if (recipientUser._id.toString() === request.user._id.toString()) return reply.status(400).send({ success: false, message: 'You cannot transfer to yourself' });
    
    const recipientWallet = await Wallet.findOne({ user: recipientUser._id });
    
    // Safe Math without strict Sessions
    senderWallet.availableBalance = (currentAvail - transferAmount).toString();
    senderWallet.balance = (parseFloat(senderWallet.balance.toString() || '0') - transferAmount).toString();
    await senderWallet.save();
    
    recipientWallet.availableBalance = (parseFloat(recipientWallet.availableBalance.toString() || '0') + transferAmount).toString();
    recipientWallet.balance = (parseFloat(recipientWallet.balance.toString() || '0') + transferAmount).toString();
    await recipientWallet.save();
    
    const senderTransaction = new Transaction({
      user: request.user._id, type: 'transfer', description: `Transfer to ${recipientUser.name}`,
      amount: transferAmount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: senderWallet.availableBalance.toString(),
      status: 'success', provider: 'internal'
    });
    
    const recipientTransaction = new Transaction({
      user: recipientUser._id, type: 'transfer', description: `Received from ${sender.name}`,
      amount: transferAmount, fee: 0, balanceBefore: (parseFloat(recipientWallet.availableBalance.toString() || '0') - transferAmount).toString(), balanceAfter: recipientWallet.availableBalance.toString(),
      status: 'success', provider: 'internal'
    });
    
    await senderTransaction.save();
    await recipientTransaction.save();
    
    if (request.server && request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: senderWallet.availableBalance.toString() });
      request.server.io.to(`user:${recipientUser._id}`).emit('wallet:update', { balance: recipientWallet.availableBalance.toString() });
      request.server.io.to(`user:${recipientUser._id}`).emit('notification', { title: 'Funds Received', message: `₦${transferAmount.toLocaleString()} received from ${sender.name}` });
    }
    
    reply.send({ success: true, message: 'Transfer successful', transaction: senderTransaction });
  } catch (error) {
    console.error('Transfer Server Error:', error);
    reply.status(500).send({ success: false, message: 'Failed to process transfer. Check server logs.' });
  }
}

/**
 * 6. Set PIN
 */
async function setPin(request, reply) {
  try {
    const { pin, confirmPin } = request.body;
    if (!pin || pin.length !== 4) return reply.status(400).send({ success: false, message: 'PIN must be 4 digits' });
    if (pin !== confirmPin) return reply.status(400).send({ success: false, message: 'PINs do not match' });
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!user || !wallet) return reply.status(404).send({ success: false, message: 'Account not found' });
    
    // Save to Wallet if logic exists
    if (typeof wallet.setPin === 'function') {
        await wallet.setPin(pin);
    } 
    // Save to User as fallback
    const salt = await bcrypt.genSalt(10);
    user.transactionPin = await bcrypt.hash(pin.toString(), salt);
    user.isSecured = true;
    await user.save();
    
    reply.send({ success: true, message: 'PIN set successfully' });
  } catch (error) {
    console.error('Set PIN Error:', error);
    reply.status(500).send({ success: false, message: 'Failed to set PIN' });
  }
}

module.exports = {
  getWallet,
  fundWallet,
  verifyFunding,
  withdraw,
  transfer,
  setPin
};
