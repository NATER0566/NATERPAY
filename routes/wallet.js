const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateTransactionReference, generateIdempotencyKey } = require('../utils/auth');
const config = require('../config');
const axios = require('axios');

/**
 * Get wallet
 */
async function getWallet(request, reply) {
  try {
    const wallet = await Wallet.findByUser(request.user._id);
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    reply.send({ success: true, wallet });
  } catch (error) {
    console.error('Get wallet error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch wallet' });
  }
}

/**
 * STEP 1: Initiate Wallet Funding
 */
async function fundWallet(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { amount, provider } = request.body;
    const paymentProvider = (provider || 'paystack').toLowerCase();
    
    if (!amount || amount < config.business.minWithdrawal) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({ success: false, message: `Minimum funding amount is ₦${config.business.minWithdrawal}` });
    }
    
    const wallet = await Wallet.findByUser(request.user._id);
    const user = await User.findById(request.user._id);
    
    if (!wallet || !user) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({ success: false, message: 'User or Wallet not found' });
    }
    
    const paymentReference = generateTransactionReference();
    
    const transaction = new Transaction({
      user: request.user._id, type: 'funding', description: `Wallet funding via ${paymentProvider}`,
      amount, fee: 0, balanceBefore: wallet.availableBalance.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: paymentProvider, providerReference: paymentReference,
      idempotencyKey: generateIdempotencyKey(), ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save({ session });
    
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
      throw new Error('Unsupported payment provider');
    }

    await session.commitTransaction();
    session.endSession();
    
    reply.send({ success: true, message: 'Payment initialized', paymentReference, checkoutUrl, provider: paymentProvider });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    reply.status(500).send({ success: false, message: 'Failed to initiate payment gateway.' });
  }
}

/**
 * STEP 2: Verify Wallet Funding
 */
async function verifyFunding(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
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

    if (!isSuccessful) throw new Error('Payment not successful at gateway');

    const wallet = await Wallet.findByUser(transaction.user);
    await wallet.credit(transaction.amount);
    
    transaction.status = 'success';
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    await AuditLog.logAction({ user: transaction.user, action: 'funding_verified', description: `Wallet funded with ₦${transaction.amount}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    await Notification.create({ user: transaction.user, title: 'Wallet Funded', message: `Your wallet has been credited with ₦${transaction.amount.toLocaleString()}`, type: 'transaction', priority: 'high' });
    
    if (request.server.io) request.server.io.to(`user:${transaction.user}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
    
    reply.send({ success: true, message: 'Payment verified and wallet credited!' });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    reply.status(500).send({ success: false, message: 'Failed to verify payment' });
  }
}

/**
 * Highly Secure Withdrawal Engine
 */
async function withdraw(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { amount, bankAccount, pin } = request.body;
    
    // Limits
    if (!amount || amount < config.business.minWithdrawal) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: `Minimum withdrawal amount is ₦${config.business.minWithdrawal}` });
    }
    if (amount > config.business.maxWithdrawal) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: `Maximum withdrawal amount is ₦${config.business.maxWithdrawal}` });
    }
    
    const wallet = await Wallet.findByUser(request.user._id);
    if (!wallet || wallet.isFrozen) {
      await session.abortTransaction(); session.endSession();
      return reply.status(403).send({ success: false, message: 'Wallet error or frozen account.' });
    }
    
    // 1. STRICT PIN VALIDATION
    if (!pin) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: 'Security PIN is required' });
    }
    if (!wallet.pinSet) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: 'Please setup your withdrawal PIN in settings first.' });
    }
    const isPinValid = await wallet.verifyPin(pin);
    if (!isPinValid) {
      await session.abortTransaction(); session.endSession();
      return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Withdrawal PIN.' });
    }

    // 2. EXACT BALANCE MATH
    const withdrawAmount = parseFloat(amount);
    const transferFee = 50; // Standard interbank fee
    const totalDeduction = withdrawAmount + transferFee;
    const currentAvail = parseFloat(wallet.availableBalance.toString());
    
    if (currentAvail < totalDeduction) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: `Insufficient Funds. You need ₦${totalDeduction.toLocaleString()} including fees.` });
    }
    
    wallet.availableBalance = (currentAvail - totalDeduction).toString();
    wallet.balance = (parseFloat(wallet.balance.toString()) - totalDeduction).toString();
    await wallet.save({ session });
    
    const transaction = new Transaction({
      user: request.user._id, type: 'withdrawal', description: `Transfer to ${bankAccount.bankName.toUpperCase()} - ${bankAccount.accountNumber}`,
      amount: withdrawAmount, fee: transferFee, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'internal', idempotencyKey: generateIdempotencyKey(), metadata: { bankAccount },
      ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Logging & Notifications
    await AuditLog.logAction({ user: request.user._id, action: 'withdrawal', description: `Wallet withdrawal of ₦${withdrawAmount}`, details: { amount: withdrawAmount, bankAccount }, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    await Notification.create({ user: request.user._id, title: 'Withdrawal Processing', message: `Your withdrawal of ₦${withdrawAmount.toLocaleString()} is being processed to your bank.`, type: 'transaction', priority: 'high' });
    
    if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
    
    reply.send({ success: true, message: 'Withdrawal processed successfully', transaction });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    reply.status(500).send({ success: false, message: 'Failed to process withdrawal' });
  }
}

/**
 * Peer-to-Peer Internal Transfer
 */
async function transfer(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { amount, recipient, pin } = request.body; // Changed 'recipientEmailOrPhone' to 'recipient' to match QR scanner payload
    const transferAmount = parseFloat(amount);
    
    if (!transferAmount || transferAmount < 100) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: 'Minimum transfer amount is ₦100' });
    }
    
    const senderWallet = await Wallet.findByUser(request.user._id);
    const sender = await User.findById(request.user._id);

    // 1. STRICT PIN VALIDATION
    if (!pin || !senderWallet.pinSet) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: 'PIN setup or entry is required.' });
    }
    const isPinValid = await senderWallet.verifyPin(pin);
    if (!isPinValid) {
      await session.abortTransaction(); session.endSession();
      return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Transfer PIN.' });
    }

    const currentAvail = parseFloat(senderWallet.availableBalance.toString());
    if (currentAvail < transferAmount) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    }
    
    // Find recipient by Phone, Email, or ID
    let query = { $or: [{ email: recipient.toLowerCase() }, { phoneNumber: recipient }] };
    if (mongoose.Types.ObjectId.isValid(recipient)) query.$or.push({ _id: recipient });

    const recipientUser = await User.findOne(query);
    if (!recipientUser) {
      await session.abortTransaction(); session.endSession();
      return reply.status(404).send({ success: false, message: 'Recipient NATERPAY ID not found' });
    }
    if (recipientUser._id.toString() === request.user._id.toString()) {
      await session.abortTransaction(); session.endSession();
      return reply.status(400).send({ success: false, message: 'You cannot transfer to yourself' });
    }
    
    const recipientWallet = await Wallet.findByUser(recipientUser._id);
    
    // 2. EXACT BALANCE MATH FOR DB DEDUCTION/CREDIT
    senderWallet.availableBalance = (currentAvail - transferAmount).toString();
    senderWallet.balance = (parseFloat(senderWallet.balance.toString()) - transferAmount).toString();
    await senderWallet.save({ session });
    
    recipientWallet.availableBalance = (parseFloat(recipientWallet.availableBalance.toString()) + transferAmount).toString();
    recipientWallet.balance = (parseFloat(recipientWallet.balance.toString()) + transferAmount).toString();
    await recipientWallet.save({ session });
    
    const senderTransaction = new Transaction({
      user: request.user._id, type: 'transfer', description: `Transfer to ${recipientUser.name}`,
      amount: transferAmount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: senderWallet.availableBalance.toString(),
      status: 'success', provider: 'internal', idempotencyKey: generateIdempotencyKey(), ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    const recipientTransaction = new Transaction({
      user: recipientUser._id, type: 'transfer', description: `Received from ${sender.name}`,
      amount: transferAmount, fee: 0, balanceBefore: (parseFloat(recipientWallet.availableBalance.toString()) - transferAmount).toString(), balanceAfter: recipientWallet.availableBalance.toString(),
      status: 'success', provider: 'internal', idempotencyKey: generateIdempotencyKey(), ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    await senderTransaction.save({ session });
    await recipientTransaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Logs and Notifications
    await AuditLog.logAction({ user: request.user._id, action: 'transfer', description: `Transfer of ₦${transferAmount} to ${recipientUser.name}`, details: { amount: transferAmount, recipientId: recipientUser._id } });
    await Notification.create({ user: request.user._id, title: 'Transfer Sent', message: `You transferred ₦${transferAmount.toLocaleString()} to ${recipientUser.name}`, type: 'transaction', priority: 'medium' });
    await Notification.create({ user: recipientUser._id, title: 'Transfer Received', message: `You received ₦${transferAmount.toLocaleString()} from ${sender.name}`, type: 'transaction', priority: 'high' });
    
    if (request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: senderWallet.availableBalance.toString() });
      request.server.io.to(`user:${recipientUser._id}`).emit('wallet:update', { balance: recipientWallet.availableBalance.toString() });
      request.server.io.to(`user:${recipientUser._id}`).emit('notification', { title: 'Funds Received', message: `₦${transferAmount.toLocaleString()} received from ${sender.name}` });
    }
    
    reply.send({ success: true, message: 'Transfer successful', transaction: senderTransaction });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    reply.status(500).send({ success: false, message: 'Failed to process transfer' });
  }
}

/**
 * Set withdrawal PIN
 */
async function setPin(request, reply) {
  try {
    const { pin, confirmPin } = request.body;
    if (!pin || pin.length !== 4) return reply.status(400).send({ success: false, message: 'PIN must be 4 digits' });
    if (pin !== confirmPin) return reply.status(400).send({ success: false, message: 'PINs do not match' });
    
    const wallet = await Wallet.findByUser(request.user._id);
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    
    await wallet.setPin(pin);
    request.user.isSecured = true;
    await request.user.save();
    
    await AuditLog.logAction({ user: request.user._id, action: 'pin_change', description: 'Withdrawal PIN set', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    
    reply.send({ success: true, message: 'PIN set successfully' });
  } catch (error) {
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
