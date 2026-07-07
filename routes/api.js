const User = require('../models/User');
const { generateApiKey, sanitizeUser } = require('../utils/auth');
const AuditLog = require('../models/AuditLog');

/**
 * Get API keys for user
 */
async function getApiKeys(request, reply) {
  try {
    const user = request.user;
    
    const apiKeys = {
      publicKey: user.apiKeys?.publicKey || null,
      testPublicKey: user.apiKeys?.testPublicKey || null,
      createdAt: user.apiKeys?.createdAt || null
    };
    
    reply.send({
      success: true,
      apiKeys
    });
  } catch (error) {
    console.error('Get API keys error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch API keys'
    });
  }
}

/**
 * Generate new API key
 */
async function generateApiKey(request, reply) {
  try {
    const { type } = request.body; // 'live' or 'test'
    
    const user = request.user;
    
    if (!user.apiKeys) {
      user.apiKeys = {};
    }
    
    const newKey = generateApiKey();
    
    if (type === 'live') {
      user.apiKeys.publicKey = newKey;
    } else {
      user.apiKeys.testPublicKey = newKey;
    }
    
    user.apiKeys.createdAt = new Date();
    await user.save();
    
    await AuditLog.logAction({
      user: user._id,
      action: 'api_key_create',
      description: `Generated new ${type} API key`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.send({
      success: true,
      message: 'API key generated successfully',
      apiKey: newKey,
      type
    });
  } catch (error) {
    console.error('Generate API key error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to generate API key'
    });
  }
}

/**
 * Revoke API key
 */
async function revokeApiKey(request, reply) {
  try {
    const { type } = request.body; // 'live' or 'test'
    
    const user = request.user;
    
    if (!user.apiKeys) {
      return reply.status(404).send({
        success: false,
        message: 'No API keys found'
      });
    }
    
    if (type === 'live') {
      user.apiKeys.publicKey = null;
    } else {
      user.apiKeys.testPublicKey = null;
    }
    
    await user.save();
    
    await AuditLog.logAction({
      user: user._id,
      action: 'api_key_revoke',
      description: `Revoked ${type} API key`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.send({
      success: true,
      message: 'API key revoked successfully'
    });
  } catch (error) {
    console.error('Revoke API key error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to revoke API key'
    });
  }
}

/**
 * API authentication middleware
 */
async function authenticateApiKey(request, reply) {
  try {
    const apiKey = request.headers['x-api-key'] || request.headers.authorization?.replace('Bearer ', '');
    
    if (!apiKey) {
      return reply.status(401).send({
        success: false,
        message: 'API key is required'
      });
    }
    
    const user = await User.findOne({
      $or: [
        { 'apiKeys.publicKey': apiKey },
        { 'apiKeys.testPublicKey': apiKey }
      ]
    });
    
    if (!user) {
      return reply.status(401).send({
        success: false,
        message: 'Invalid API key'
      });
    }
    
    if (!user.isActive || user.isSuspended) {
      return reply.status(403).send({
        success: false,
        message: 'Account is inactive or suspended'
      });
    }
    
    request.user = user;
    request.userId = user._id;
    request.isTestKey = user.apiKeys?.testPublicKey === apiKey;
  } catch (error) {
    return reply.status(401).send({
      success: false,
      message: 'Authentication failed'
    });
  }
}

/**
 * API: Get balance
 */
async function apiGetBalance(request, reply) {
  try {
    const Wallet = require('../models/Wallet');
    const wallet = await Wallet.findByUser(request.user._id);
    
    reply.send({
      success: true,
      balance: wallet ? wallet.availableBalance.toString() : '0',
      isTest: request.isTestKey
    });
  } catch (error) {
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch balance'
    });
  }
}

/**
 * API: Create transaction
 */
async function apiCreateTransaction(request, reply) {
  const session = await require('../models/Wallet').startSession();
  session.startTransaction();
  
  try {
    const { type, amount, description, metadata } = request.body;
    
    if (!type || !amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Type and amount are required'
      });
    }
    
    const Wallet = require('../models/Wallet');
    const Transaction = require('../models/Transaction');
    
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
    
    if (parseFloat(balanceBefore) < amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Insufficient balance'
      });
    }
    
    const transaction = new Transaction({
      user: request.user._id,
      type,
      description: description || 'API Transaction',
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'success',
      provider: 'api',
      metadata: metadata || {},
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    await wallet.debit(amount);
    transaction.balanceAfter = wallet.availableBalance.toString();
    
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    reply.send({
      success: true,
      transaction: {
        id: transaction._id,
        type: transaction.type,
        amount: transaction.amount.toString(),
        status: transaction.status,
        balanceBefore: transaction.balanceBefore.toString(),
        balanceAfter: transaction.balanceAfter.toString(),
        createdAt: transaction.createdAt
      },
      isTest: request.isTestKey
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('API create transaction error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to create transaction'
    });
  }
}

module.exports = {
  getApiKeys,
  generateApiKey,
  revokeApiKey,
  authenticateApiKey,
  apiGetBalance,
  apiCreateTransaction
};
