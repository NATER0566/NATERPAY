const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateTransactionReference, generateIdempotencyKey } = require('../utils/auth');
const config = require('../config');
const axios = require('axios');

/**
 * Get VTU rates
 */
async function getRates(request, reply) {
  try {
    const CMS = require('../models/CMS');
    const cms = await CMS.getHomepageData();
    
    reply.send({
      success: true,
      rates: cms?.homepage?.rates || {
        mtn: 215,
        airtel: 190,
        glo: 220,
        nineMobile: 180
      }
    });
  } catch (error) {
    console.error('Get rates error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch rates'
    });
  }
}

/**
 * Buy airtime
 */
async function buyAirtime(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { phone, network, amount, pin } = request.body;
    
    if (!phone || !network || !amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Phone, network, and amount are required'
      });
    }
    
    if (amount < 50) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Minimum airtime amount is ₦50'
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
        message: 'Wallet is frozen'
      });
    }
    
    // Verify PIN if set
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
      type: 'airtime',
      description: `Airtime recharge for ${phone}`,
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'processing',
      provider: 'vtpass',
      idempotencyKey: generateIdempotencyKey(),
      serviceDetails: {
        phone,
        network,
        amount
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    // Process with VTU provider (simplified - would integrate with VTpass/VTUGate)
    try {
      // Simulate VTU API call
      const providerResponse = await processVTURequest('airtime', {
        phone,
        network,
        amount
      });
      
      transaction.providerReference = providerResponse.reference;
      transaction.status = 'success';
      transaction.providerResponse = providerResponse;
      
      await wallet.debit(amount);
      transaction.balanceAfter = wallet.availableBalance.toString();
      
      await transaction.save({ session });
      
      await session.commitTransaction();
      session.endSession();
      
      // Log audit
      await AuditLog.logAction({
        user: request.user._id,
        action: 'transaction_create',
        description: `Airtime purchase: ₦${amount} to ${phone}`,
        details: { phone, network, amount, providerReference: providerResponse.reference },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      });
      
      // Send notification
      await Notification.create({
        user: request.user._id,
        title: 'Airtime Purchase Successful',
        message: `₦${amount.toLocaleString()} airtime sent to ${phone}`,
        type: 'transaction',
        priority: 'medium'
      });
      
      reply.send({
        success: true,
        message: 'Airtime purchase successful',
        transaction
      });
      
    } catch (vtuError) {
      await session.abortTransaction();
      session.endSession();
      
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save();
      
      reply.status(500).send({
        success: false,
        message: 'VTU provider error',
        error: vtuError.message
      });
    }
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Buy airtime error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to purchase airtime'
    });
  }
}

/**
 * Buy data
 */
async function buyData(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { phone, network, plan, amount, pin } = request.body;
    
    if (!phone || !network || !plan || !amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'Phone, network, plan, and amount are required'
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
        message: 'Wallet is frozen'
      });
    }
    
    // Verify PIN if set
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
    
    const transaction = new Transaction({
      user: request.user._id,
      type: 'data',
      description: `${plan} data for ${phone}`,
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'processing',
      provider: 'vtpass',
      idempotencyKey: generateIdempotencyKey(),
      serviceDetails: {
        phone,
        network,
        plan,
        amount
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    try {
      const providerResponse = await processVTURequest('data', {
        phone,
        network,
        plan,
        amount
      });
      
      transaction.providerReference = providerResponse.reference;
      transaction.status = 'success';
      transaction.providerResponse = providerResponse;
      
      await wallet.debit(amount);
      transaction.balanceAfter = wallet.availableBalance.toString();
      
      await transaction.save({ session });
      
      await session.commitTransaction();
      session.endSession();
      
      await AuditLog.logAction({
        user: request.user._id,
        action: 'transaction_create',
        description: `Data purchase: ${plan} for ${phone}`,
        details: { phone, network, plan, amount },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      });
      
      await Notification.create({
        user: request.user._id,
        title: 'Data Purchase Successful',
        message: `${plan} data sent to ${phone}`,
        type: 'transaction',
        priority: 'medium'
      });
      
      reply.send({
        success: true,
        message: 'Data purchase successful',
        transaction
      });
      
    } catch (vtuError) {
      await session.abortTransaction();
      session.endSession();
      
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save();
      
      reply.status(500).send({
        success: false,
        message: 'VTU provider error',
        error: vtuError.message
      });
    }
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Buy data error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to purchase data'
    });
  }
}

/**
 * Buy electricity
 */
async function buyElectricity(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { meterNumber, disco, amount, meterType, pin } = request.body;
    
    if (!meterNumber || !disco || !amount || !meterType) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'All fields are required'
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
        message: 'Wallet is frozen'
      });
    }
    
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
    
    const transaction = new Transaction({
      user: request.user._id,
      type: 'electricity',
      description: `Electricity bill payment for meter ${meterNumber}`,
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'processing',
      provider: 'vtpass',
      idempotencyKey: generateIdempotencyKey(),
      serviceDetails: {
        meterNumber,
        disco,
        amount,
        meterType
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    try {
      const providerResponse = await processVTURequest('electricity', {
        meterNumber,
        disco,
        amount,
        meterType
      });
      
      transaction.providerReference = providerResponse.reference;
      transaction.status = 'success';
      transaction.providerResponse = providerResponse;
      
      await wallet.debit(amount);
      transaction.balanceAfter = wallet.availableBalance.toString();
      
      await transaction.save({ session });
      
      await session.commitTransaction();
      session.endSession();
      
      await AuditLog.logAction({
        user: request.user._id,
        action: 'transaction_create',
        description: `Electricity payment: ₦${amount} for meter ${meterNumber}`,
        details: { meterNumber, disco, amount },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      });
      
      await Notification.create({
        user: request.user._id,
        title: 'Electricity Payment Successful',
        message: `₦${amount.toLocaleString()} paid for meter ${meterNumber}`,
        type: 'transaction',
        priority: 'medium'
      });
      
      reply.send({
        success: true,
        message: 'Electricity payment successful',
        transaction,
        token: providerResponse.token
      });
      
    } catch (vtuError) {
      await session.abortTransaction();
      session.endSession();
      
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save();
      
      reply.status(500).send({
        success: false,
        message: 'VTU provider error',
        error: vtuError.message
      });
    }
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Buy electricity error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process electricity payment'
    });
  }
}

/**
 * Buy cable TV subscription
 */
async function buyCable(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { smartcardNumber, provider, package: pkg, amount, pin } = request.body;
    
    if (!smartcardNumber || !provider || !pkg || !amount) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: 'All fields are required'
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
        message: 'Wallet is frozen'
      });
    }
    
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
    
    const transaction = new Transaction({
      user: request.user._id,
      type: 'cable',
      description: `${provider} ${pkg} subscription`,
      amount,
      fee: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
      status: 'processing',
      provider: 'vtpass',
      idempotencyKey: generateIdempotencyKey(),
      serviceDetails: {
        smartcardNumber,
        provider,
        package: pkg,
        amount
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    try {
      const providerResponse = await processVTURequest('cable', {
        smartcardNumber,
        provider,
        package: pkg,
        amount
      });
      
      transaction.providerReference = providerResponse.reference;
      transaction.status = 'success';
      transaction.providerResponse = providerResponse;
      
      await wallet.debit(amount);
      transaction.balanceAfter = wallet.availableBalance.toString();
      
      await transaction.save({ session });
      
      await session.commitTransaction();
      session.endSession();
      
      await AuditLog.logAction({
        user: request.user._id,
        action: 'transaction_create',
        description: `Cable subscription: ${provider} ${pkg}`,
        details: { smartcardNumber, provider, package: pkg, amount },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      });
      
      await Notification.create({
        user: request.user._id,
        title: 'Cable Subscription Successful',
        message: `${provider} ${pkg} subscription activated`,
        type: 'transaction',
        priority: 'medium'
      });
      
      reply.send({
        success: true,
        message: 'Cable subscription successful',
        transaction
      });
      
    } catch (vtuError) {
      await session.abortTransaction();
      session.endSession();
      
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save();
      
      reply.status(500).send({
        success: false,
        message: 'VTU provider error',
        error: vtuError.message
      });
    }
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Buy cable error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process cable subscription'
    });
  }
}

// Helper function to process VTU requests (would integrate with actual providers)
async function processVTURequest(type, data) {
  // This is a simplified version - in production, integrate with VTpass/VTUGate
  // For now, we'll simulate successful responses
  
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() > 0.1) {
        // 90% success rate simulation
        resolve({
          reference: 'VTU_' + Date.now(),
          token: type === 'electricity' ? '1234567890123456' : null,
          status: 'success'
        });
      } else {
        reject(new Error('VTU provider temporarily unavailable'));
      }
    }, 2000);
  });
}

module.exports = {
  getRates,
  buyAirtime,
  buyData,
  buyElectricity,
  buyCable
};
