const Invoice = require('../models/Invoice');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const crypto = require('crypto');

// Safely load optional logging modules to prevent server crashes
let AuditLog, Notification, generateIdempotencyKey;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { generateIdempotencyKey = require('../utils/auth').generateIdempotencyKey; } catch(e) {}

/**
 * 1. Get user's invoices (Dashboard view)
 */
async function getInvoices(request, reply) {
  try {
    const invoices = await Invoice.find({ user: request.user._id }).sort({ createdAt: -1 });
    
    reply.send({
      success: true,
      invoices: invoices.map(inv => ({
        _id: inv._id,
        invoiceId: inv.invoiceId,
        customerName: inv.customerName,
        customerEmail: inv.customerEmail,
        total: inv.total ? inv.total.toString() : '0',
        currency: inv.currency || 'NGN',
        status: inv.status,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        createdAt: inv.createdAt
      }))
    });
  } catch (error) {
    console.error('Get invoices error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch invoices ledger'
    });
  }
}

/**
 * 2. Create invoice (Strict Mathematics Engine)
 */
async function createInvoice(request, reply) {
  try {
    const { customerName, customerEmail, customerPhone, items, taxRate, discountRate, dueDate, notes } = request.body;
    
    if (!customerName || !customerEmail || !items || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: 'Customer name, email, and valid items are required'
      });
    }
    
    // EXACT MATHEMATICS ENGINE
    let subtotal = 0;
    const processedItems = items.map(item => {
        const qty = parseFloat(item.quantity) || 1;
        const price = parseFloat(item.unitPrice) || 0;
        const lineTotal = qty * price;
        subtotal += lineTotal;
        return { 
            description: item.description, 
            quantity: qty, 
            unitPrice: price,
            total: lineTotal
        };
    });
    
    const tax = parseFloat(taxRate) || 0;
    const discount = parseFloat(discountRate) || 0;
    
    const taxAmount = subtotal * (tax / 100);
    const discountAmount = subtotal * (discount / 100);
    const finalTotal = subtotal + taxAmount - discountAmount;
    
    const invoiceId = 'INV' + crypto.randomBytes(4).toString('hex').toUpperCase();
    
    const invoice = new Invoice({
      user: request.user._id,
      invoiceId,
      customerName,
      customerEmail,
      customerPhone,
      items: processedItems,
      subtotal,
      taxRate: tax,
      discountRate: discount,
      total: finalTotal,
      dueDate: new Date(dueDate || Date.now()),
      notes,
      status: 'sent'
    });
    
    await invoice.save();
    
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({
          user: request.user._id,
          action: 'invoice_create',
          description: `Invoice created for ${customerName}`,
          details: { invoiceId: invoice.invoiceId, total: finalTotal },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent']
        }).catch(e => console.warn('AuditLog suppressed:', e.message));
    }
    
    reply.status(201).send({
      success: true,
      message: 'Invoice mathematically verified and issued.',
      invoice: {
        _id: invoice._id,
        invoiceId: invoice.invoiceId,
        url: `${request.headers.host || ''}/invoice/${invoice.invoiceId}`,
        total: invoice.total.toString()
      }
    });
  } catch (error) {
    console.error('Create invoice error:', error);
    reply.status(500).send({
      success: false,
      message: 'System error during invoice generation'
    });
  }
}

/**
 * 3. Get invoice by ID (Public Customer View)
 */
async function getInvoice(request, reply) {
  try {
    const { invoiceId } = request.params;
    
    const invoice = await Invoice.findOne({ invoiceId });
    
    if (!invoice) {
      return reply.status(404).send({ success: false, message: 'Invoice not found in the ledger' });
    }
    
    reply.send({
      success: true,
      invoice: {
        invoiceId: invoice.invoiceId,
        customerName: invoice.customerName,
        customerEmail: invoice.customerEmail,
        items: invoice.items,
        subtotal: invoice.subtotal ? invoice.subtotal.toString() : '0',
        taxRate: invoice.taxRate,
        discountRate: invoice.discountRate,
        total: invoice.total ? invoice.total.toString() : '0',
        currency: invoice.currency || 'NGN',
        dueDate: invoice.dueDate,
        notes: invoice.notes,
        status: invoice.status
      }
    });
  } catch (error) {
    console.error('Get invoice error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch invoice details' });
  }
}

/**
 * 4. Pay invoice (Atomic Transactions & Revenue Fee Logic)
 */
async function payInvoice(request, reply) {
  // Use MongoDB sessions to ensure money is never lost if the server crashes halfway
  let session = null;
  if (typeof Wallet.startSession === 'function') {
      session = await Wallet.startSession();
      session.startTransaction();
  }
  
  try {
    const { invoiceId } = request.params;
    const { paymentMethod, gatewayReference } = request.body;
    
    const invoice = await Invoice.findOne({ invoiceId });
    
    if (!invoice) {
      if(session) { await session.abortTransaction(); session.endSession(); }
      return reply.status(404).send({ success: false, message: 'Invoice not found' });
    }
    
    if (['paid', 'cancelled'].includes(invoice.status)) {
      if(session) { await session.abortTransaction(); session.endSession(); }
      return reply.status(400).send({ success: false, message: `Invoice is already ${invoice.status}` });
    }

    const paidAmount = parseFloat(invoice.total.toString());
    
    // NATERPAY Business Logic: Take a 1.5% gateway/platform fee before crediting the merchant
    const platformFee = paidAmount * 0.015;
    const finalCredit = paidAmount - platformFee;

    const wallet = await Wallet.findOne({ user: invoice.user });
    if (!wallet) throw new Error("Merchant wallet not found");

    const currentAvail = parseFloat(wallet.availableBalance.toString() || '0');
    
    // Credit Merchant Wallet
    wallet.availableBalance = (currentAvail + finalCredit).toString();
    wallet.balance = (parseFloat(wallet.balance.toString() || '0') + finalCredit).toString();
    await wallet.save({ session });
    
    // Log the transaction
    const transaction = new Transaction({
      user: invoice.user,
      type: 'invoice',
      description: `Invoice Payment Settled: ${invoice.customerName} (#${invoice.invoiceId})`,
      amount: finalCredit,
      fee: platformFee,
      balanceBefore: currentAvail.toString(),
      balanceAfter: wallet.availableBalance.toString(),
      status: 'success',
      provider: paymentMethod || 'paystack',
      providerReference: gatewayReference || 'INV_' + Date.now(),
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `inv_pay_${Date.now()}`,
      invoiceDetails: {
        invoiceId: invoice.invoiceId,
        customerEmail: invoice.customerEmail,
        customerName: invoice.customerName
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    // Update Invoice Status
    invoice.status = 'paid';
    invoice.paidAt = new Date();
    await invoice.save({ session });
    
    if(session) {
        await session.commitTransaction();
        session.endSession();
    }
    
    // Push Notification
    if (Notification && typeof Notification.create === 'function') {
        await Notification.create({
          user: invoice.user,
          title: 'Invoice Paid',
          message: `Invoice ${invoice.invoiceId} has been paid by ${invoice.customerName}. ₦${finalCredit.toLocaleString()} added to your wallet.`,
          type: 'transaction',
          priority: 'high'
        }).catch(e => console.warn('Notification suppressed:', e.message));
    }
    
    // Real-Time UI Update
    if (request.server && request.server.io) {
      request.server.io.to(`user:${invoice.user}`).emit('wallet:update', {
        balance: wallet.availableBalance.toString()
      });
      request.server.io.to(`user:${invoice.user}`).emit('notification', { 
        type: 'success', 
        title: 'Invoice Paid!', 
        message: `${invoice.customerName} paid their invoice. ₦${finalCredit.toLocaleString()} credited.` 
      });
    }
    
    reply.send({
      success: true,
      message: 'Invoice payment authorized and settled.',
      transaction
    });
  } catch (error) {
    if(session) { await session.abortTransaction(); session.endSession(); }
    console.error('Pay invoice error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to process invoice payment'
    });
  }
}

module.exports = {
  getInvoices,
  createInvoice,
  getInvoice,
  payInvoice
};
