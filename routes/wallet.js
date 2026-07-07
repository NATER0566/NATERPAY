const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateTransactionReference, generateIdempotencyKey } = require('../utils/auth');
const config = require('../config');

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
 * Fund wallet
 */
async function fundWallet(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { amount, paymentMethod, provider } = request.body;
    
    if (!amount || amount < config.business.minWithdrawal) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: `Minimum funding amount is ₦${config.business.minWithdrawal}`
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
    
    const balanceBefore = wallet.availableBalance.toString();
    
    // Create transaction
    const transaction = new Transaction({
      user: request.user._id,
      type: 'funding',
      description: 'Wallet funding',
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'pending',
      provider: provider || 'paystack',
      idempotencyKey: generateIdempotencyKey(),
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    // Initiate payment with provider (simplified - would integrate with Paystack/Flutterwave)
    // For now, we'll simulate successful funding
    const paymentReference = generateTransactionReference();
    transaction.providerReference = paymentReference;
    transaction.status = 'success';
    transaction.balanceAfter = (parseFloat(balanceBefore) + amount).toString();
    
    await wallet.credit(amount);
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Log audit
    await AuditLog.logAction({
      user: request.user._id,
      action: 'funding',
      description: `Wallet funded with ₦${amount}`,
      details: { amount, paymentMethod, provider },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    // Send notification
    await Notification.create({
      user: request.user._id,
      title: 'Wallet Funded',
      message: `Your wallet has been funded with ₦${amount.toLocaleString()}`,
      type: 'transaction',
      priority: 'medium'
    });
    
    // Emit socket event
    if (request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', {
        balance: wallet.availableBalance.toString()
      });
    }
    
    reply.send({
      success: true,
      message: 'Wallet funded successfully',
      transaction,
      paymentReference
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Fund wallet error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fund wallet'
    });
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
  withdraw,
  transfer,
  setPin
};
