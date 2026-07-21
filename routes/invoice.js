const Invoice = require('../models/Invoice');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const crypto = require('crypto');
const { Resend } = require('resend');

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

let AuditLog, Notification, generateIdempotencyKey;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { generateIdempotencyKey = require('../utils/auth').generateIdempotencyKey; } catch(e) {}

/**
 * 1. Get user's invoices
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
        createdAt: inv.createdAt,
        businessLogoBase64: inv.businessLogoBase64,
        businessDetails: inv.businessDetails
      }))
    });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to fetch invoices ledger' });
  }
}

/**
 * 2. Create invoice & Send Email (STRICT LIMITS APPLIED)
 */
async function createInvoice(request, reply) {
  try {
    // 1. ENFORCE STRICT MONTHLY LIMITS ON THE BACKEND
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const invoiceCount = await Invoice.countDocuments({ user: request.user._id, createdAt: { $gte: startOfMonth } });
    
    // Fetch user to safely check role
    const user = await User.findById(request.user._id);
    const userRole = (user.role || 'user').toLowerCase();

    if (userRole === 'user' && invoiceCount >= 3) {
        return reply.status(403).send({ success: false, message: 'Standard users are limited to 3 invoices per month. Upgrade to Reseller.' });
    }
    if ((userRole === 'reseller' || userRole === 'agent') && invoiceCount >= 50) {
        return reply.status(403).send({ success: false, message: 'Reseller limit is 50 invoices per month. Upgrade to VIP.' });
    }

    const { customerName, customerEmail, customerPhone, items, taxRate, discountRate, dueDate, notes, terms, businessLogoBase64, businessDetails, currency } = request.body;
    
    if (!customerName || !customerEmail || !items || items.length === 0) {
      return reply.status(400).send({ success: false, message: 'Customer name, email, and valid items are required' });
    }
    
    // 2. STRICT SERVER-SIDE MATHEMATICS ENGINE
    let subtotal = 0;
    const processedItems = items.map(item => {
        const qty = parseFloat(item.quantity) || 1;
        const price = parseFloat(item.unitPrice) || 0;
        const lineTotal = qty * price;
        subtotal += lineTotal;
        return { description: item.description, quantity: qty, unitPrice: price, total: lineTotal };
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
      currency: currency || 'NGN',
      items: processedItems, 
      subtotal, 
      taxRate: tax, 
      discountRate: discount,
      total: finalTotal, 
      dueDate: new Date(dueDate || Date.now()), 
      notes, 
      terms,
      status: 'sent',
      businessLogoBase64: businessLogoBase64 || null,
      businessDetails: businessDetails || {}
    });
    
    await invoice.save();
    
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const invoiceLink = `${protocol}://${host}/invoice-view.html?id=${invoice.invoiceId}`;

    const senderEmail = process.env.EMAIL_FROM || 'support@naterpay.com'; 

    try {
        await resend.emails.send({
            from: `NATERPAY Billing <${senderEmail}>`, 
            to: customerEmail,
            subject: `New Invoice from NATERPAY (INV: ${invoice.invoiceId})`,
            html: `
                <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #333; border-radius: 15px; background-color: #0a0a0a; color: #ffffff; word-wrap: break-word;">
                    <h2 style="color: #FFD700; text-align: center; border-bottom: 2px solid #FFD700; padding-bottom: 15px; letter-spacing: 2px;">NATERPAY SECURE INVOICE</h2>
                    <p style="font-size: 16px;">Hello <strong>${customerName}</strong>,</p>
                    <p style="font-size: 16px; color: #ccc;">You have received a new invoice requesting payment.</p>
                    
                    <div style="background-color: #1a1a1a; padding: 20px; border-radius: 10px; margin: 25px 0; border: 1px solid #333; word-wrap: break-word;">
                        <p style="margin: 5px 0; font-size: 14px; color: #888;">Invoice ID:</p>
                        <p style="margin: 0 0 15px 0; font-size: 18px; font-weight: bold; word-break: break-all;">${invoice.invoiceId}</p>
                        
                        <p style="margin: 5px 0; font-size: 14px; color: #888;">Total Amount Due:</p>
                        <p style="margin: 0 0 15px 0; font-size: 24px; font-weight: bold; color: #FFD700;">${invoice.currency} ${finalTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
                        
                        <p style="margin: 5px 0; font-size: 14px; color: #888;">Due Date:</p>
                        <p style="margin: 0; font-size: 16px; font-weight: bold; color: #ff3333;">${new Date(invoice.dueDate).toLocaleDateString()}</p>
                    </div>
                    
                    <div style="text-align: center; margin: 40px 0;">
                        <a href="${invoiceLink}" style="background-color: #FFD700; color: #000; padding: 15px 30px; text-decoration: none; font-weight: bold; border-radius: 8px; font-size: 16px; text-transform: uppercase; letter-spacing: 1px; display: inline-block;">View & Pay Securely</a>
                    </div>
                </div>
            `
        });
    } catch (emailError) {
        console.error('Email failed:', emailError.message);
    }

    reply.status(201).send({
      success: true,
      message: 'Invoice generated.',
      invoice: { invoiceId: invoice.invoiceId, url: invoiceLink, total: invoice.total.toString() }
    });
  } catch (error) {
    console.error('Create invoice error:', error);
    reply.status(500).send({ success: false, message: 'System error during invoice generation' });
  }
}

/**
 * 3. Get invoice by ID (Public)
 */
async function getInvoice(request, reply) {
  try {
    const { invoiceId } = request.params;
    const invoice = await Invoice.findOne({ invoiceId });
    
    if (!invoice) return reply.status(404).send({ success: false, message: 'Invoice not found in the ledger' });
    
    reply.send({
      success: true,
      paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
      invoice: {
        invoiceId: invoice.invoiceId, customerName: invoice.customerName, customerEmail: invoice.customerEmail,
        items: invoice.items, subtotal: invoice.subtotal ? invoice.subtotal.toString() : '0',
        taxRate: invoice.taxRate, discountRate: invoice.discountRate, total: invoice.total ? invoice.total.toString() : '0',
        currency: invoice.currency || 'NGN', dueDate: invoice.dueDate, notes: invoice.notes, terms: invoice.terms,
        status: invoice.status, businessLogoBase64: invoice.businessLogoBase64, businessDetails: invoice.businessDetails,
        createdAt: invoice.createdAt
      }
    });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to fetch invoice details' });
  }
}

/**
 * 4. Pay invoice
 */
async function payInvoice(request, reply) {
  try {
    const { invoiceId } = request.params;
    const { paymentMethod, gatewayReference } = request.body;
    
    const invoice = await Invoice.findOne({ invoiceId });
    if (!invoice) return reply.status(404).send({ success: false, message: 'Invoice not found' });
    if (['paid', 'cancelled'].includes(invoice.status)) return reply.status(400).send({ success: false, message: `Invoice is already ${invoice.status}` });

    const paidAmount = parseFloat(invoice.total.toString());
    const platformFee = paidAmount * 0.015;
    const finalCredit = paidAmount - platformFee;

    const wallet = await Wallet.findOne({ user: invoice.user });
    if (!wallet) throw new Error("Merchant wallet not found");

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    wallet.availableBalance = String(currentAvail + finalCredit);
    wallet.balance = String(parseFloat(wallet.balance?.toString() || '0') + finalCredit);
    await wallet.save();
    
    const transaction = new Transaction({
      user: invoice.user, type: 'invoice', description: `Invoice Payment Settled: ${invoice.customerName} (#${invoice.invoiceId})`,
      amount: finalCredit, fee: platformFee, balanceBefore: String(currentAvail), balanceAfter: String(wallet.availableBalance || 0),
      status: 'success', provider: paymentMethod || 'paystack', providerReference: gatewayReference || 'INV_' + Date.now(),
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `inv_pay_${Date.now()}`,
      invoiceDetails: { invoiceId: invoice.invoiceId, customerEmail: invoice.customerEmail, customerName: invoice.customerName },
      ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save();
    
    invoice.status = 'paid';
    invoice.paidAt = new Date();
    await invoice.save();
    
    if (request.server && request.server.io) {
      request.server.io.to(`user:${invoice.user}`).emit('wallet:update', { balance: String(wallet.availableBalance || 0) });
    }
    reply.send({ success: true, message: 'Invoice payment authorized and settled.', transaction });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to process invoice payment' });
  }
}

/**
 * 5. Delete Invoice (NEW)
 */
async function deleteInvoice(request, reply) {
    try {
        const { id } = request.params;
        const deleted = await Invoice.findOneAndDelete({ _id: id, user: request.user._id });
        if (!deleted) return reply.status(404).send({ success: false, message: 'Invoice not found or unauthorized.' });
        reply.send({ success: true, message: 'Invoice permanently deleted from ledger.' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'System error deleting invoice.' });
    }
}

/**
 * 6. Mark Invoice as Paid Manually (NEW)
 */
async function markInvoicePaid(request, reply) {
    try {
        const { id } = request.params;
        const updated = await Invoice.findOneAndUpdate(
            { _id: id, user: request.user._id }, 
            { status: 'paid', paidAt: new Date() },
            { new: true }
        );
        if (!updated) return reply.status(404).send({ success: false, message: 'Invoice not found or unauthorized.' });
        reply.send({ success: true, message: 'Invoice marked as paid.' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'System error updating status.' });
    }
}

module.exports = {
  getInvoices, createInvoice, getInvoice, payInvoice, deleteInvoice, markInvoicePaid
};
