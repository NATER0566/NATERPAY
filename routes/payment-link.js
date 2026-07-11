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
        createdAt: link.createdAt,
        // E-Commerce Additions
        redirectUrl: link.redirectUrl,
        productImageBase64: link.productImageBase64
      }))
    });
  } catch (error) {
    console.error('Get payment links error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch payment links' });
  }
}

/**
 * 2. Create a new payment link (Storefront Product)
 */
async function createLink(request, reply) {
  try {
    const { 
        title, description, amount, currency, isFlexibleAmount, 
        minAmount, maxAmount, collectCustomerName, collectCustomerEmail, 
        collectCustomerPhone, maxTransactions, expiryDate, 
        redirectUrl, productImageBase64 
    } = request.body;
    
    if (!title) {
      return reply.status(400).send({ success: false, message: 'Product title is required' });
    }

    // Generate a secure, unique string for the URL
    const linkId = 'LN_' + crypto.randomBytes(5).toString('hex').toUpperCase();
    
    const paymentLink = new PaymentLink({
      user: request.user._id,
      linkId,
      title,
      description: description || 'Secure NATERPAY Product',
      amount: isFlexibleAmount ? 0 : parseFloat(amount || 0),
      currency: currency || 'NGN',
      isFlexibleAmount: isFlexibleAmount || false,
      minAmount: isFlexibleAmount ? minAmount : null,
      maxAmount: isFlexibleAmount ? maxAmount : null,
      collectCustomerName: collectCustomerName !== false,
      collectCustomerEmail: collectCustomerEmail !== false,
      collectCustomerPhone: collectCustomerPhone || false,
      maxTransactions: maxTransactions || null,
      expiryDate: expiryDate || null,
      // E-Commerce Additions
      redirectUrl: redirectUrl || '',
      productImageBase64: productImageBase64 || null
    });
    
    await paymentLink.save();
    
    // Safely log the action
    if (AuditLog && typeof AuditLog.logAction === 'function') {
      await AuditLog.logAction({
        user: request.user._id,
        action: 'payment_link_create',
        description: `Storefront product created: ${title}`,
        details: { linkId: paymentLink.linkId, amount },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      }).catch(e => console.warn('Audit log suppressed', e.message));
    }
    
    reply.status(201).send({
      success: true,
      message: 'Product published to storefront successfully',
      linkId: paymentLink.linkId
    });
  } catch (error) {
    console.error('Create payment link error:', error);
    reply.status(500).send({ success: false, message: 'Failed to create storefront link' });
  }
}

/**
 * 3. Get payment link by ID (Public Customer View loaded by pay.html)
 */
async function getLink(request, reply) {
  try {
    const { id } = request.params;
    
    // Look for linkId using isActive to match your schema logic
    const paymentLink = await PaymentLink.findOne({ linkId: id }).populate('user', 'name');
    
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
      paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY, // Dynamic injection from Render Env
      link: {
        linkId: paymentLink.linkId,
        title: paymentLink.title,
        description: paymentLink.description,
        amount: paymentLink.amount ? paymentLink.amount.toString() : '0',
        currency: paymentLink.currency,
        isFlexibleAmount: paymentLink.isFlexibleAmount,
        minAmount: paymentLink.minAmount?.toString(),
        maxAmount: paymentLink.maxAmount?.toString(),
        collectCustomerName: paymentLink.collectCustomerName,
        collectCustomerEmail: paymentLink.collectCustomerEmail,
        merchantName: paymentLink.user ? paymentLink.user.name : 'Merchant',
        // E-Commerce Additions
        redirectUrl: paymentLink.redirectUrl,
        productImageBase64: paymentLink.productImageBase64
      }
    });
  } catch (error) {
    console.error('Get payment link error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch payment link details' });
  }
}

/**
 * 4. Process the Link Payment (Calculates 2.5% Platform Fee & Teleports user)
 */
async function payLink(request, reply) {
  try {
    const { id } = request.params;
    const { customerName, customerEmail, customerPhone, gatewayReference, paymentMethod } = request.body;
    
    // Map data gracefully
    const paymentAmount = parseFloat(request.body.amount || request.body.paidAmount || 0);
    
    const paymentLink = await PaymentLink.findOne({ linkId: id });
    
    if (!paymentLink) {
      return reply.status(404).send({ success: false, message: 'Product route missing' });
    }
    if (!paymentLink.isActive) {
      return reply.status(410).send({ success: false, message: 'Product is no longer available' });
    }
    
    // --- NATERPAY REVENUE ENGINE ---
    // Calculate NATERPAY Platform Fees (2.5% total processing fee)
    const platformFee = paymentAmount * 0.025; 
    const finalCredit = paymentAmount - platformFee;
    // -------------------------------

    // Safely fetch and credit the Merchant's Wallet
    const wallet = await Wallet.findOne({ user: paymentLink.user });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Merchant wallet not found' });

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    wallet.availableBalance = String(currentAvail + finalCredit);
    wallet.balance = String(parseFloat(wallet.balance?.toString() || '0') + finalCredit);
    await wallet.save();

    // Create the Audit Transaction Log
    const transaction = new Transaction({
      user: paymentLink.user,
      type: 'payment_link',
      description: `Storefront Sale: ${paymentLink.title} (Buyer: ${customerName || 'Anonymous'})`,
      amount: finalCredit,
      fee: platformFee,
      balanceBefore: String(currentAvail),
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
    
    // Update link statistics safely
    paymentLink.transactionCount = (paymentLink.transactionCount || 0) + 1;
    paymentLink.totalCollected = String(parseFloat(paymentLink.totalCollected?.toString() || '0') + paymentAmount);
    await paymentLink.save();
    
    // Database Notification
    if (Notification && typeof Notification.create === 'function') {
      await Notification.create({
        user: paymentLink.user,
        title: 'Product Sale!',
        message: `₦${finalCredit.toLocaleString()} received via storefront: ${paymentLink.title}`,
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
        title: 'New Sale!', 
        message: `You received ₦${finalCredit.toLocaleString()} from: ${paymentLink.title}` 
      });
      request.server.io.to(`user:${paymentLink.user}`).emit('dashboard:refresh');
    }
    
    reply.send({
      success: true,
      message: 'Payment verified and settled.',
      transaction,
      redirectUrl: paymentLink.redirectUrl // Passed to frontend to teleport the buyer
    });
  } catch (error) {
    console.error('Pay storefront link error:', error);
    reply.status(500).send({ success: false, message: 'Failed to process payment fulfillment' });
  }
}

module.exports = {
  getLinks,
  createLink,
  getLink,
  payLink
};
