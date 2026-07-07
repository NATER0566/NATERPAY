const PaymentLink = require('../models/PaymentLink');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateIdempotencyKey } = require('../utils/auth');

/**
 * Get user's payment links
 */
async function getLinks(request, reply) {
  try {
    const links = await PaymentLink.findByUser(request.user._id);
    
    reply.send({
      success: true,
      links: links.map(link => ({
        _id: link._id,
        linkId: link.linkId,
        title: link.title,
        description: link.description,
        amount: link.amount.toString(),
        currency: link.currency,
        isFlexibleAmount: link.isFlexibleAmount,
        isActive: link.isActive,
        transactionCount: link.transactionCount,
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
 * Create payment link
 */
async function createLink(request, reply) {
  try {
    const { title, description, amount, isFlexibleAmount, minAmount, maxAmount, collectCustomerName, collectCustomerEmail, collectCustomerPhone, maxTransactions, expiryDate, successUrl, cancelUrl } = request.body;
    
    if (!title || !amount) {
      return reply.status(400).send({
        success: false,
        message: 'Title and amount are required'
      });
    }
    
    const paymentLink = new PaymentLink({
      user: request.user._id,
      title,
      description,
      amount,
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
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'payment_link_create',
      description: `Payment link created: ${title}`,
      details: { linkId: paymentLink.linkId, amount },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.status(201).send({
      success: true,
      message: 'Payment link created successfully',
      link: {
        _id: paymentLink._id,
        linkId: paymentLink.linkId,
        url: `${request.headers.host}/pay/${paymentLink.linkId}`,
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
 * Get payment link by ID (public)
 */
async function getLink(request, reply) {
  try {
    const { linkId } = request.params;
    
    const paymentLink = await PaymentLink.findByLinkId(linkId);
    
    if (!paymentLink) {
      return reply.status(404).send({
        success: false,
        message: 'Payment link not found'
      });
    }
    
    if (!paymentLink.isActive) {
      return reply.status(404).send({
        success: false,
        message: 'Payment link is inactive'
      });
    }
    
    if (paymentLink.isExpired()) {
      return reply.status(410).send({
        success: false,
        message: 'Payment link has expired'
      });
    }
    
    if (paymentLink.isMaxReached()) {
      return reply.status(410).send({
        success: false,
        message: 'Payment link has reached maximum transactions'
      });
    }
    
    reply.send({
      success: true,
      link: {
        linkId: paymentLink.linkId,
        title: paymentLink.title,
        description: paymentLink.description,
        amount: paymentLink.amount.toString(),
        currency: paymentLink.currency,
        isFlexibleAmount: paymentLink.isFlexibleAmount,
        minAmount: paymentLink.minAmount?.toString(),
        maxAmount: paymentLink.maxAmount?.toString(),
        collectCustomerName: paymentLink.collectCustomerName,
        collectCustomerEmail: paymentLink.collectCustomerEmail,
        collectCustomerPhone: paymentLink.collectCustomerPhone
      }
    });
  } catch (error) {
    console.error('Get payment link error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch payment link'
    });
  }
}

/**
 * Pay payment link
 */
async function payLink(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { linkId } = request.params;
    const { amount, customerName, customerEmail, customerPhone, paymentMethod } = request.body;
    
    const paymentLink = await PaymentLink.findByLinkId(linkId);
    
    if (!paymentLink) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'Payment link not found'
      });
    }
    
    if (!paymentLink.isActive || paymentLink.isExpired() || paymentLink.isMaxReached()) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(410).send({
        success: false,
        message: 'Payment link is not available'
      });
    }
    
    const paymentAmount = paymentLink.isFlexibleAmount ? amount : paymentLink.amount;
    
    // Create transaction
    const transaction = new Transaction({
      user: paymentLink.user,
      type: 'payment_link',
      description: `Payment link: ${paymentLink.title}`,
      amount: paymentAmount,
      fee: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      status: 'pending',
      provider: 'internal',
      idempotencyKey: generateIdempotencyKey(),
      paymentLinkDetails: {
        linkId: paymentLink.linkId,
        customerEmail: customerEmail || null,
        customerName: customerName || null
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    // Process payment (would integrate with payment providers)
    // For now, simulate successful payment
    transaction.status = 'success';
    transaction.providerReference = 'PAY_' + Date.now();
    
    // Credit user's wallet
    const wallet = await Wallet.findByUser(paymentLink.user);
    if (wallet) {
      await wallet.credit(paymentAmount);
    }
    
    await paymentLink.incrementTransactionCount();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Notify user
    await Notification.create({
      user: paymentLink.user,
      title: 'Payment Received',
      message: `₦${paymentAmount.toLocaleString()} received via payment link: ${paymentLink.title}`,
      type: 'transaction',
      priority: 'high'
    });
    
    // Emit socket event
    if (request.server.io) {
      request.server.io.to(`user:${paymentLink.user}`).emit('wallet:update', {
        balance: wallet?.availableBalance.toString()
      });
    }
    
    reply.send({
      success: true,
      message: 'Payment successful',
      transaction
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Pay payment link error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process payment'
    });
  }
}

module.exports = {
  getLinks,
  createLink,
  getLink,
  payLink
};
