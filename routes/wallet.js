const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateTransactionReference, generateIdempotencyKey } = require('../utils/auth');
const config = require('../config');
const axios = require('axios'); // Added for API requests

/**
 * Get wallet
 */
async function getWallet(request, reply) {
  try {
    const wallet = await Wallet.findByUser(request.user._id);
    
    if (!wallet) {
      return reply.status(404).send({
        success: false,
        message: 'Wallet not found'
      });
    }
    
    reply.send({
      success: true,
      wallet
    });
  } catch (error) {
    console.error('Get wallet error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch wallet'
    });
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
      return reply.status(400).send({
        success: false,
        message: `Minimum funding amount is ₦${config.business.minWithdrawal}`
      });
    }
    
    const wallet = await Wallet.findByUser(request.user._id);
    const user = await User.findById(request.user._id); // Needed for email/name
    
    if (!wallet || !user) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'User or Wallet not found'
      });
    }
    
    const paymentReference = generateTransactionReference();
    
    // Create pending transaction
    const transaction = new Transaction({
      user: request.user._id,
      type: 'funding',
      description: `Wallet funding via ${paymentProvider}`,
      amount,
      fee: 0,
      balanceBefore: wallet.availableBalance.toString(),
      balanceAfter: wallet.availableBalance.toString(),
      status: 'pending',
      provider: paymentProvider,
      providerReference: paymentReference,
      idempotencyKey: generateIdempotencyKey(),
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    let checkoutUrl = '';

    // -----------------------------------------------------
    // PAYSTACK INITIALIZATION
    // -----------------------------------------------------
    if (paymentProvider === 'paystack') {
      const paystackResponse = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount: amount * 100, // Paystack expects amount in Kobo
          reference: paymentReference,
          callback_url: `${request.protocol}://${request.hostname}/dashboard.html` // Where to redirect after payment
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      checkoutUrl = paystackResponse.data.data.authorization_url;
    } 
    // -----------------------------------------------------
    // MONNIFY INITIALIZATION
    // -----------------------------------------------------
    else if (paymentProvider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      
      // 1. Get Monnify Access Token
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, {
        headers: { Authorization: `Basic ${encodedKeys}` }
      });
      const accessToken = authResponse.data.responseBody.accessToken;

      // 2. Initialize Transaction
      const initResponse = await axios.post(
        `${baseUrl}/api/v1/merchant/transactions/init-transaction`,
        {
          amount: amount,
          customerName: user.name,
          customerEmail: user.email,
          paymentReference: paymentReference,
          paymentDescription: 'NATERPAY Wallet Funding',
          currencyCode: 'NGN',
          contractCode: process.env.MONNIFY_CONTRACT_CODE,
          redirectUrl: `${request.protocol}://${request.hostname}/dashboard.html`
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      checkoutUrl = initResponse.data.responseBody.checkoutUrl;
    } else {
      throw new Error('Unsupported payment provider');
    }

    await session.commitTransaction();
    session.endSession();
    
    // Return the checkout URL to the frontend so the user can pay
    reply.send({
      success: true,
      message: 'Payment initialized',
      paymentReference,
      checkoutUrl, // Frontend should redirect the user to this URL
      provider: paymentProvider
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Fund wallet error:', error.response?.data || error.message);
    reply.status(500).send({
      success: false,
      message: 'Failed to initiate payment gateway. Check API Keys.'
    });
  }
}

/**
 * STEP 2: Verify Wallet Funding
 * (Call this endpoint after the user returns from the payment page)
 */
async function verifyFunding(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { reference } = request.body;
    
    if (!reference) {
      return reply.status(400).send({ success: false, message: 'Payment reference is required' });
    }
    
    const transaction = await Transaction.findOne({ providerReference: reference });
    
    if (!transaction) {
      return reply.status(404).send({ success: false, message: 'Transaction not found' });
    }
    
    if (transaction.status === 'success') {
      return reply.send({ success: true, message: 'Wallet already credited' });
    }

    let isSuccessful = false;

    // -----------------------------------------------------
    // VERIFY PAYSTACK
    // -----------------------------------------------------
    if (transaction.provider === 'paystack') {
      const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });
      if (response.data.data.status === 'success') isSuccessful = true;
    } 
    // -----------------------------------------------------
    // VERIFY MONNIFY
    // -----------------------------------------------------
    else if (transaction.provider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, {
        headers: { Authorization: `Basic ${encodedKeys}` }
      });
      const accessToken = authResponse.data.responseBody.accessToken;

      const response = await axios.get(`${baseUrl}/api/v1/merchant/transactions/query?paymentReference=${reference}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (response.data.responseBody.paymentStatus === 'PAID') isSuccessful = true;
    }

    if (!isSuccessful) {
      throw new Error('Payment not successful at gateway');
    }

    // Give the user their money!
    const wallet = await Wallet.findByUser(transaction.user);
    await wallet.credit(transaction.amount);
    
    transaction.status = 'success';
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Log audit & Send notification
    await AuditLog.logAction({
      user: transaction.user,
      action: 'funding_verified',
      description: `Wallet funded with ₦${transaction.amount}`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await Notification.create({
      user: transaction.user,
      title: 'Wallet Funded',
      message: `Your wallet has been credited with ₦${transaction.amount.toLocaleString()}`,
      type: 'transaction',
      priority: 'high'
    });
    
    if (request.server.io) {
      request.server.io.to(`user:${transaction.user}`).emit('wallet:update', {
        balance: wallet.availableBalance.toString()
      });
    }
    
    reply.send({ success: true, message: 'Payment verified and wallet credited!' });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Verify funding error:', error.message);
    reply.status(500).send({ success: false, message: 'Failed to verify payment' });
  }
}

/**
 * Withdraw from wallet
 */
async function withdraw(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { amount, bankAccount, pin } = request.body;
    
    if (!amount || amount < config.business.minWithdrawal) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: `Minimum withdrawal amount is ₦${config.business.minWithdrawal}`
      });
    }
    
    if (amount > config.business.maxWithdrawal) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: `Maximum withdrawal amount is ₦${config.business.maxWithdrawal}`
      });
    }
    
    const wallet = await Wallet.findByUser(request.user._id);
    if (!wallet) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'Wallet not found'
      });
    }
    
    if (wallet.isFrozen) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(403).send({
        success: false,
        message: 'Wallet is frozen. Please contact support.'
      });
    }
    
    // Verify PIN
    if (wallet.pinSet) {
      const isPinValid = await wallet.verifyPin(pin);
      if (!isPinValid) {
        await session.abortTransaction();
        session.endSession();
        return reply.status(401).send({
          success: false,
          message: 'Invalid PIN'
        });
      }
    }
    
    const balanceBefore = wallet.availableBalance.toString();
    
    if (parseFloat(balanceBefore) < amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Insufficient balance'
      });
    }
    
    // Create transaction
    const transaction = new Transaction({
      user: request.user._id,
      type: 'withdrawal',
      description: 'Wallet withdrawal',
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'pending',
      provider: 'internal',
      idempotencyKey: generateIdempotencyKey(),
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    await wallet.debit(amount);
    transaction.balanceAfter = wallet.availableBalance.toString();
    transaction.status = 'success';
    
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Log audit
    await AuditLog.logAction({
      user: request.user._id,
      action: 'withdrawal',
      description: `Wallet withdrawal of ₦${amount}`,
      details: { amount, bankAccount },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    // Send notification
    await Notification.create({
      user: request.user._id,
      title: 'Withdrawal Processed',
      message: `Your withdrawal of ₦${amount.toLocaleString()} has been processed`,
      type: 'transaction',
      priority: 'high'
    });
    
    // Emit socket event
    if (request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', {
        balance: wallet.availableBalance.toString()
      });
    }
    
    reply.send({
      success: true,
      message: 'Withdrawal processed successfully',
      transaction
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Withdrawal error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process withdrawal'
    });
  }
}

/**
 * Transfer to another user
 */
async function transfer(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { amount, recipientEmailOrPhone, pin } = request.body;
    
    if (!amount || amount < 100) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Minimum transfer amount is ₦100'
      });
    }
    
    const senderWallet = await Wallet.findByUser(request.user._id);
    if (!senderWallet) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'Wallet not found'
      });
    }
    
    // Verify PIN
    if (senderWallet.pinSet) {
      const isPinValid = await senderWallet.verifyPin(pin);
      if (!isPinValid) {
        await session.abortTransaction();
        session.endSession();
        return reply.status(401).send({
          success: false,
          message: 'Invalid PIN'
        });
      }
    }
    
    const senderBalanceBefore = senderWallet.availableBalance.toString();
    
    if (parseFloat(senderBalanceBefore) < amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Insufficient balance'
      });
    }
    
    // Find recipient
    const recipient = await User.findOne({
      $or: [
        { email: recipientEmailOrPhone.toLowerCase() },
        { phoneNumber: recipientEmailOrPhone }
      ]
    });
    
    if (!recipient) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'Recipient not found'
      });
    }
    
    if (recipient._id.toString() === request.user._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Cannot transfer to yourself'
      });
    }
    
    const recipientWallet = await Wallet.findByUser(recipient._id);
    if (!recipientWallet) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'Recipient wallet not found'
      });
    }
    
    // Debit sender
    await senderWallet.debit(amount);
    
    // Credit recipient
    await recipientWallet.credit(amount);
    
    // Create sender transaction
    const senderTransaction = new Transaction({
      user: request.user._id,
      type: 'transfer',
      description: `Transfer to ${recipient.name}`,
      amount,
      fee: 0,
      balanceBefore: senderBalanceBefore,
      balanceAfter: senderWallet.availableBalance.toString(),
      status: 'success',
      provider: 'internal',
      idempotencyKey: generateIdempotencyKey(),
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    // Create recipient transaction
    const recipientTransaction = new Transaction({
      user: recipient._id,
      type: 'transfer',
      description: `Transfer from ${request.user.name}`,
      amount,
      fee: 0,
      balanceBefore: (parseFloat(recipientWallet.availableBalance.toString()) - amount).toString(),
      balanceAfter: recipientWallet.availableBalance.toString(),
      status: 'success',
      provider: 'internal',
      idempotencyKey: generateIdempotencyKey(),
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await senderTransaction.save({ session });
    await recipientTransaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Log audit
    await AuditLog.logAction({
      user: request.user._id,
      action: 'transfer',
      description: `Transfer of ₦${amount} to ${recipient.name}`,
      details: { amount, recipientId: recipient._id },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    // Send notifications
    await Notification.create({
      user: request.user._id,
      title: 'Transfer Sent',
      message: `You transferred ₦${amount.toLocaleString()} to ${recipient.name}`,
      type: 'transaction',
      priority: 'medium'
    });
    
    await Notification.create({
      user: recipient._id,
      title: 'Transfer Received',
      message: `You received ₦${amount.toLocaleString()} from ${request.user.name}`,
      type: 'transaction',
      priority: 'medium'
    });
    
    // Emit socket events
    if (request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', {
        balance: senderWallet.availableBalance.toString()
      });
      request.server.io.to(`user:${recipient._id}`).emit('wallet:update', {
        balance: recipientWallet.availableBalance.toString()
      });
    }
    
    reply.send({
      success: true,
      message: 'Transfer successful',
      transaction: senderTransaction
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Transfer error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process transfer'
    });
  }
}

/**
 * Set withdrawal PIN
 */
async function setPin(request, reply) {
  try {
    const { pin, confirmPin } = request.body;
    
    if (!pin || pin.length !== 4) {
      return reply.status(400).send({
        success: false,
        message: 'PIN must be 4 digits'
      });
    }
    
    if (pin !== confirmPin) {
      return reply.status(400).send({
        success: false,
        message: 'PINs do not match'
      });
    }
    
    const wallet = await Wallet.findByUser(request.user._id);
    if (!wallet) {
      return reply.status(404).send({
        success: false,
        message: 'Wallet not found'
      });
    }
    
    await wallet.setPin(pin);
    
    // Update user security status
    request.user.isSecured = true;
    await request.user.save();
    
    // Log audit
    await AuditLog.logAction({
      user: request.user._id,
      action: 'pin_change',
      description: 'Withdrawal PIN set',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.send({
      success: true,
      message: 'PIN set successfully'
    });
  } catch (error) {
    console.error('Set PIN error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to set PIN'
    });
  }
}

module.exports = {
  getWallet,
  fundWallet,
  verifyFunding, // NEW FUNCTION ADDED
  withdraw,
  transfer,
  setPin
};
