const Invoice = require('../models/Invoice');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateIdempotencyKey } = require('../utils/auth');

/**
 * Get user's invoices
 */
async function getInvoices(request, reply) {
  try {
    const invoices = await Invoice.findByUser(request.user._id);
    
    reply.send({
      success: true,
      invoices: invoices.map(inv => ({
        _id: inv._id,
        invoiceId: inv.invoiceId,
        customerName: inv.customerName,
        customerEmail: inv.customerEmail,
        total: inv.total.toString(),
        currency: inv.currency,
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
      message: 'Failed to fetch invoices'
    });
  }
}

/**
 * Create invoice
 */
async function createInvoice(request, reply) {
  try {
    const { customerName, customerEmail, customerPhone, items, taxRate, discountRate, dueDate, notes } = request.body;
    
    if (!customerName || !customerEmail || !items || !items.length) {
      return reply.status(400).send({
        success: false,
        message: 'Customer name, email, and items are required'
      });
    }
    
    // Calculate totals
    let subtotal = 0;
    const processedItems = items.map(item => {
      const total = item.quantity * item.unitPrice;
      subtotal += total;
      return {
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total
      };
    });
    
    const tax = subtotal * (taxRate || 0) / 100;
    const discount = subtotal * (discountRate || 0) / 100;
    const total = subtotal + tax - discount;
    
    const invoice = new Invoice({
      user: request.user._id,
      customerName,
      customerEmail,
      customerPhone,
      items: processedItems,
      subtotal,
      tax,
      taxRate: taxRate || 0,
      discount,
      discountRate: discountRate || 0,
      total,
      dueDate: new Date(dueDate),
      notes
    });
    
    await invoice.save();
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'invoice_create',
      description: `Invoice created for ${customerName}`,
      details: { invoiceId: invoice.invoiceId, total },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.status(201).send({
      success: true,
      message: 'Invoice created successfully',
      invoice: {
        _id: invoice._id,
        invoiceId: invoice.invoiceId,
        url: `${request.headers.host}/invoice/${invoice.invoiceId}`,
        total: invoice.total.toString()
      }
    });
  } catch (error) {
    console.error('Create invoice error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to create invoice'
    });
  }
}

/**
 * Get invoice by ID (public)
 */
async function getInvoice(request, reply) {
  try {
    const { invoiceId } = request.params;
    
    const invoice = await Invoice.findByInvoiceId(invoiceId);
    
    if (!invoice) {
      return reply.status(404).send({
        success: false,
        message: 'Invoice not found'
      });
    }
    
    reply.send({
      success: true,
      invoice: {
        invoiceId: invoice.invoiceId,
        customerName: invoice.customerName,
        customerEmail: invoice.customerEmail,
        items: invoice.items,
        subtotal: invoice.subtotal.toString(),
        tax: invoice.tax.toString(),
        taxRate: invoice.taxRate,
        discount: invoice.discount.toString(),
        discountRate: invoice.discountRate,
        total: invoice.total.toString(),
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        notes: invoice.notes,
        status: invoice.status
      }
    });
  } catch (error) {
    console.error('Get invoice error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch invoice'
    });
  }
}

/**
 * Pay invoice
 */
async function payInvoice(request, reply) {
  const session = await Wallet.startSession();
  session.startTransaction();
  
  try {
    const { invoiceId } = request.params;
    const { paymentMethod } = request.body;
    
    const invoice = await Invoice.findByInvoiceId(invoiceId);
    
    if (!invoice) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(404).send({
        success: false,
        message: 'Invoice not found'
      });
    }
    
    if (['paid', 'cancelled'].includes(invoice.status)) {
      await session.abortTransaction();
      session.endSession();
      return reply.status(400).send({
        success: false,
        message: `Invoice is already ${invoice.status}`
      });
    }
    
    // Create transaction
    const transaction = new Transaction({
      user: invoice.user,
      type: 'invoice',
      description: `Invoice payment: ${invoice.customerName}`,
      amount: invoice.total,
      fee: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      status: 'pending',
      provider: 'internal',
      idempotencyKey: generateIdempotencyKey(),
      invoiceDetails: {
        invoiceId: invoice.invoiceId,
        customerEmail: invoice.customerEmail,
        customerName: invoice.customerName
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    // Process payment
    transaction.status = 'success';
    transaction.providerReference = 'INV_' + Date.now();
    
    // Credit user's wallet
    const wallet = await Wallet.findByUser(invoice.user);
    if (wallet) {
      await wallet.credit(invoice.total);
    }
    
    await invoice.markAsPaid(transaction.providerReference, paymentMethod);
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    
    // Notify user
    await Notification.create({
      user: invoice.user,
      title: 'Invoice Paid',
      message: `Invoice ${invoice.invoiceId} has been paid by ${invoice.customerName}`,
      type: 'transaction',
      priority: 'high'
    });
    
    // Emit socket event
    if (request.server.io) {
      request.server.io.to(`user:${invoice.user}`).emit('wallet:update', {
        balance: wallet?.availableBalance.toString()
      });
    }
    
    reply.send({
      success: true,
      message: 'Invoice payment successful',
      transaction
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
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
