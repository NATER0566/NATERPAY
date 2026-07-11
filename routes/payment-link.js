const PaymentLink = require('../models/PaymentLink');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const crypto = require('crypto');

// Conditionally load these to prevent crashes if files are missing/renamed
let AuditLog, Notification, generateIdempotencyKey;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { generateIdempotencyKey = require('../utils/auth').generateIdempotencyKey; } catch(e) {}

/**
 * 1. Get user's payment links (Dashboard View)
 */
async function getLinks(request, reply) {
  try {
    const links = await PaymentLink.find({ user: request.user._id }).sort({ createdAt: -1 });
    
    reply.send({
      success: true,
      links: links.map(link => ({
        _id: link._id,
        linkId: link.linkId,
        title: link.title,
        description: link.description,
        amount: link.amount ? link.amount.toString() : '0',
        currency: link.currency || 'NGN',
        isFlexibleAmount: link.isFlexibleAmount,
        isActive: link.isActive,
        transactionCount: link.transactionCount || 0,
        totalCollected: link.totalCollected ? link.totalCollected.toString() : '0',
        expiryDate: link.expiryDate,
        createdAt: link.createdAt
      }))
    });
  } catch (error) {
    console.error('Get payment links error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch payment links'
    });
  }
}

/**
 * 2. Create a new payment link
 */
async function createLink(request, reply) {
  try {
    const { title, description, amount, currency, isFlexibleAmount, minAmount, maxAmount, collectCustomerName, collectCustomerEmail, collectCustomerPhone, maxTransactions, expiryDate, successUrl, cancelUrl } = request.body;
    
    if (!title || (!amount && !isFlexibleAmount)) {
      return reply.status(400).send({
        success: false,
        message: 'Title and amount are required'
      });
    }

    // Generate a secure, unique 10-character string for the URL
    const linkId = crypto.randomBytes(5).toString('hex');
    
    const paymentLink = new PaymentLink({
      user: request.user._id,
      linkId,
      title,
      description: description || '',
      amount: amount || 0,
      currency: currency || 'NGN',
      isFlexibleAmount: isFlexibleAmount || false,
      minAmount: isFlexibleAmount ? minAmount : null,
      maxAmount: isFlexibleAmount ? maxAmount : null,
      collectCustomerName: collectCustomerName !== false,
      collectCustomerEmail: collectCustomerEmail !== false,
      collectCustomerPhone: collectCustomerPhone || false,
      maxTransactions: maxTransactions || null,
      expiryDate: expiryDate || null,
      successUrl: successUrl || null,
      cancelUrl: cancelUrl || null
    });
    
    await paymentLink.save();
    
    // Safely log the action if AuditLog model exists
    if (AuditLog && typeof AuditLog.logAction === 'function') {
      await AuditLog.logAction({
        user: request.user._id,
        action: 'payment_link_create',
        description: `Payment link created: ${title}`,
        details: { linkId: paymentLink.linkId, amount },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      }).catch(e => console.warn('Audit log suppressed', e.message));
    }
    
    reply.status(201).send({
      success: true,
      message: 'Payment link created successfully',
      link: {
        _id: paymentLink._id,
        linkId: paymentLink.linkId,
        url: `${request.headers.host || ''}/pay/${paymentLink.linkId}`,
        title: paymentLink.title,
        amount: paymentLink.amount.toString()
      }
    });
  } catch (error) {
    console.error('Create payment link error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to create payment link'
    });
  }
}

/**
 * 3. Get payment link by ID (Public Customer View)
 */
async function getLink(request, reply) {
  try {
    const { linkId } = request.params;
    
    const paymentLink = await PaymentLink.findOne({ linkId }).populate('user', 'name');
    
    if (!paymentLink) {
      return reply.status(404).send({ success: false, message: 'Payment link not found' });
    }
    
    if (!paymentLink.isActive) {
      return reply.status(410).send({ success: false, message: 'Payment link is inactive' });
    }
    
    // Protect against custom model methods failing if they don't exist
    if (typeof paymentLink.isExpired === 'function' && paymentLink.isExpired()) {
      return reply.status(410).send({ success: false, message: 'Payment link has expired' });
    }
    if (typeof paymentLink.isMaxReached === 'function' && paymentLink.isMaxReached()) {
      return reply.status(410).send({ success: false, message: 'Payment link has reached maximum transactions' });
    }
    
    reply.send({
      success: true,
      linkData: {
        linkId: paymentLink.linkId,
        title: paymentLink.title,
        description: paymentLink.description,
        amount: paymentLink.amount ? paymentLink.amount.toString() : '0',
        currency: paymentLink.currency,
        isFlexible: paymentLink.isFlexibleAmount,
        minAmount: paymentLink.minAmount?.toString(),
        maxAmount: paymentLink.maxAmount?.toString(),
        collectCustomerName: paymentLink.collectCustomerName,
        collectCustomerEmail: paymentLink.collectCustomerEmail,
        merchantName: paymentLink.user ? paymentLink.user.name : 'Merchant'
      }
    });
  } catch (error) {
    console.error('Get payment link error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch payment link details'
    });
  }
}

/**
 * 4. Process the Link Payment (Webhook execution after payment gateway success)
 */
async function payLink(request, reply) {
  try {
    const { linkId } = request.params;
    // Map data gracefully between old format & new gateway formats
    const paymentAmount = parseFloat(request.body.paidAmount || request.body.amount);
    const { customerName, customerEmail, customerPhone, gatewayReference, paymentMethod } = request.body;
    
    const paymentLink = await PaymentLink.findOne({ linkId });
    
    if (!paymentLink) {
      return reply.status(404).send({ success: false, message: 'Payment link not found' });
    }
    if (!paymentLink.isActive) {
      return reply.status(410).send({ success: false, message: 'Payment link is not available' });
    }
    
    // Calculate NATERPAY Platform Fees (1.5%)
    const fee = paymentAmount * 0.015;
    const finalCredit = paymentAmount - fee;

    // Safely fetch and credit the Merchant's Wallet
    const wallet = await Wallet.findOne({ user: paymentLink.user });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Merchant wallet not found' });

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    wallet.availableBalance = (currentAvail + finalCredit).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') + finalCredit).toString();
    await wallet.save();

    // Create the Audit Transaction Log
    const transaction = new Transaction({
      user: paymentLink.user,
      type: 'payment_link',
      description: `Link Payment Received: ${paymentLink.title} from ${customerName || 'Anonymous Customer'}`,
      amount: finalCredit,
      fee: fee,
      balanceBefore: currentAvail.toString(),
      balanceAfter: wallet.availableBalance.toString(),
      status: 'success',
      provider: paymentMethod || 'paystack',
      providerReference: gatewayReference || 'PAY_' + Date.now(),
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `plink_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
      paymentLinkDetails: {
        linkId: paymentLink.linkId,
        customerEmail: customerEmail || null,
        customerName: customerName || null
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    await transaction.save();
    
    // Update link statistics
    paymentLink.transactionCount = (paymentLink.transactionCount || 0) + 1;
    paymentLink.totalCollected = (parseFloat(paymentLink.totalCollected?.toString() || '0') + paymentAmount).toString();
    await paymentLink.save();
    
    // Database Notification
    if (Notification && typeof Notification.create === 'function') {
      await Notification.create({
        user: paymentLink.user,
        title: 'Payment Received',
        message: `₦${finalCredit.toLocaleString()} received via payment link: ${paymentLink.title}`,
        type: 'transaction',
        priority: 'high'
      }).catch(e => console.warn('Notification log suppressed', e.message));
    }
    
    // Real-Time Socket.io UI Alert
    if (request.server && request.server.io) {
      request.server.io.to(`user:${paymentLink.user}`).emit('wallet:update', {
        balance: wallet.availableBalance.toString()
      });
      request.server.io.to(`user:${paymentLink.user}`).emit('notification', { 
        type: 'success', 
        title: 'Incoming Funds!', 
        message: `You received ₦${finalCredit.toLocaleString()} from your link: ${paymentLink.title}` 
      });
    }
    
    reply.send({
      success: true,
      message: 'Payment routed successfully to Merchant',
      transaction
    });
  } catch (error) {
    console.error('Pay payment link error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process payment data'
    });
  }
}

module.exports = {
  getLinks,
  createLink,
  getLink,
  payLink
};
