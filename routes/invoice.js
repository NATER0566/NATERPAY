const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const crypto = require('crypto');
const { Resend } = require('resend');
const Joi = require('joi'); // [1] Strict Request Validation

const resend = new Resend(process.env.RESEND_API_KEY);

// [2] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let AuditLog, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

// [3] STRICT MONEY PRECISION HELPER
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    if (isNaN(num)) return 0;
    return num;
};

// [4] TEXT SANITIZATION (Critical XSS Protection for Invoices & Emails)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 500) : '';

// [5] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

/* =========================================================================
   [6] REDIS RATE LIMITING ENGINE (Anti-Spam & DDoS Protection)
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 20) {
    const identifier = request.user ? request.user._id : request.ip;
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const key = `rate_${action}_${identifier}`;
        if (!fallbackRateLimits.has(key)) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(key);
        if (now > data.resetTime) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const key = `rate:${action}:${identifier}`;
            const count = await redisClient.incr(key);
            if (count === 1) await redisClient.expire(key, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

/* =========================================================================
   [7] IMMUTABLE AUDIT LOGGING ENGINE
========================================================================= */
async function createAuditLog(params, session = null) {
    if (!AuditLog) return;
    try {
        const log = new AuditLog({
            user: params.user, transactionId: params.transactionId, transactionReference: params.reference,
            amount: params.amount, type: params.type, previousBalance: String(params.previousBalance),
            newBalance: String(params.newBalance), ipAddress: params.ipAddress, userAgent: params.userAgent,
            status: params.status, source: params.source
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

/* ============================================================================
   1. GET USER INVOICES
============================================================================ */
async function getInvoices(request, reply) {
    try {
        if (!await checkRateLimit(request, 'fetch_invoices', 60)) throw { status: 429, message: 'Too many requests.' };

        const invoices = await Invoice.find({ user: request.user._id }).sort({ createdAt: -1 });
        
        reply.send({
            success: true,
            invoices: invoices.map(inv => ({
                _id: inv._id, invoiceId: inv.invoiceId, customerName: inv.customerName, customerEmail: inv.customerEmail,
                total: inv.total ? inv.total.toString() : '0', currency: inv.currency || 'NGN', status: inv.status,
                dueDate: inv.dueDate, paidAt: inv.paidAt, createdAt: inv.createdAt,
                businessLogoBase64: inv.businessLogoBase64, businessDetails: inv.businessDetails
            }))
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch invoices ledger'); }
}

/* ============================================================================
   2. CREATE INVOICE & SEND EMAIL (STRICT MATH & XSS PROTECTION)
============================================================================ */
async function createInvoice(request, reply) {
    try {
        if (!await checkRateLimit(request, 'create_invoice', 10)) throw { status: 429, message: 'Too many invoice creations. Slow down.' };

        // [1] Strict Joi Validation
        const schema = Joi.object({
            customerName: Joi.string().required(), customerEmail: Joi.string().email().required(),
            customerPhone: Joi.string().allow('', null), currency: Joi.string().default('NGN'),
            items: Joi.array().items(Joi.object({
                description: Joi.string().required(), quantity: Joi.number().min(1).required(), unitPrice: Joi.number().min(0).required()
            })).min(1).required(),
            taxRate: Joi.number().min(0).default(0), discountRate: Joi.number().min(0).default(0),
            dueDate: Joi.date().iso().allow('', null), notes: Joi.string().allow('', null), terms: Joi.string().allow('', null),
            businessLogoBase64: Joi.string().allow('', null), businessDetails: Joi.object().allow(null)
        });

        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        // ENFORCE STRICT MONTHLY LIMITS
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const invoiceCount = await Invoice.countDocuments({ user: request.user._id, createdAt: { $gte: startOfMonth } });
        
        const user = await User.findById(request.user._id);
        const userRole = (user.role || 'user').toLowerCase();

        if (userRole === 'user' && invoiceCount >= 3) throw new Error('Standard users are limited to 3 invoices per month. Upgrade to Reseller.');
        if ((userRole === 'reseller' || userRole === 'agent') && invoiceCount >= 50) throw new Error('Reseller limit is 50 invoices per month. Upgrade to VIP.');

        // [8] STRICT SERVER-SIDE MATHEMATICS ENGINE
        let subtotal = 0;
        const processedItems = value.items.map(item => {
            const qty = sanitizeAmount(item.quantity);
            const price = sanitizeAmount(item.unitPrice);
            const lineTotal = sanitizeAmount(qty * price);
            subtotal = sanitizeAmount(subtotal + lineTotal);
            return { description: sanitizeText(item.description), quantity: qty, unitPrice: price, total: lineTotal };
        });
        
        const tax = sanitizeAmount(value.taxRate);
        const discount = sanitizeAmount(value.discountRate);
        const taxAmount = sanitizeAmount(subtotal * (tax / 100));
        const discountAmount = sanitizeAmount(subtotal * (discount / 100));
        const finalTotal = sanitizeAmount(subtotal + taxAmount - discountAmount);
        
        const invoiceId = 'INV' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const safeCustomerName = sanitizeText(value.customerName);
        
        const invoice = new Invoice({
            user: request.user._id, invoiceId, customerName: safeCustomerName, customerEmail: value.customerEmail.toLowerCase(), 
            customerPhone: sanitizeText(value.customerPhone), currency: sanitizeText(value.currency), items: processedItems, 
            subtotal, taxRate: tax, discountRate: discount, total: finalTotal, dueDate: new Date(value.dueDate || Date.now()), 
            notes: sanitizeText(value.notes), terms: sanitizeText(value.terms), status: 'sent',
            businessLogoBase64: value.businessLogoBase64 || null, businessDetails: value.businessDetails || {}
        });
        
        await invoice.save();

        await createAuditLog({
            user: request.user._id, transactionId: invoice._id, reference: invoiceId, amount: finalTotal,
            type: 'invoice_created', previousBalance: '0', newBalance: '0', ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Invoice API'
        });
        
        const protocol = request.headers['x-forwarded-proto'] || 'http';
        const host = request.headers.host;
        const invoiceLink = `${protocol}://${host}/invoice-view.html?id=${invoice.invoiceId}`;
        const senderEmail = process.env.EMAIL_FROM || 'support@naterpay.com'; 

        try {
            await resend.emails.send({
                from: `NATERPAY Billing <${senderEmail}>`, to: invoice.customerEmail, subject: `New Invoice from NATERPAY (INV: ${invoice.invoiceId})`,
                html: `
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #333; border-radius: 15px; background-color: #0a0a0a; color: #ffffff; word-wrap: break-word;">
                        <h2 style="color: #FFD700; text-align: center; border-bottom: 2px solid #FFD700; padding-bottom: 15px; letter-spacing: 2px;">NATERPAY SECURE INVOICE</h2>
                        <p style="font-size: 16px;">Hello <strong>${safeCustomerName}</strong>,</p>
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
        } catch (emailError) { logger.warn('Invoice Email failed to send', emailError); }

        reply.status(201).send({ success: true, message: 'Invoice generated.', invoice: { invoiceId: invoice.invoiceId, url: invoiceLink, total: invoice.total.toString() } });
    } catch (error) { handleError(reply, error, 'System error during invoice generation'); }
}

/* ============================================================================
   3. GET INVOICE BY ID (PUBLIC API)
============================================================================ */
async function getInvoice(request, reply) {
    try {
        if (!await checkRateLimit(request, 'get_single_invoice', 60)) throw { status: 429, message: 'Too many requests.' };

        const { invoiceId } = request.params;
        const invoice = await Invoice.findOne({ invoiceId: sanitizeText(invoiceId) });
        
        if (!invoice) throw { status: 404, message: 'Invoice not found in the ledger' };
        
        reply.send({
            success: true, paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
            invoice: {
                invoiceId: invoice.invoiceId, customerName: invoice.customerName, customerEmail: invoice.customerEmail,
                items: invoice.items, subtotal: invoice.subtotal ? invoice.subtotal.toString() : '0',
                taxRate: invoice.taxRate, discountRate: invoice.discountRate, total: invoice.total ? invoice.total.toString() : '0',
                currency: invoice.currency || 'NGN', dueDate: invoice.dueDate, notes: invoice.notes, terms: invoice.terms,
                status: invoice.status, businessLogoBase64: invoice.businessLogoBase64, businessDetails: invoice.businessDetails,
                createdAt: invoice.createdAt
            }
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch invoice details'); }
}

/* ============================================================================
   4. PAY INVOICE (ATOMIC DATABASE SESSION ENGINE)
============================================================================ */
async function payInvoice(request, reply) {
    try {
        const schema = Joi.object({ paymentMethod: Joi.string().required(), gatewayReference: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { invoiceId } = request.params;
        const idempotencyKey = `inv_pay_${value.gatewayReference}`; 

        const existingTx = await Transaction.findOne({ idempotencyKey });
        if (existingTx) return reply.send({ success: true, message: 'Payment already processed.', transaction: existingTx });

        // [9] ATOMIC SESSION WRAPPER (Prevents Double Spends & Data Inconsistency)
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const invoice = await Invoice.findOne({ invoiceId: sanitizeText(invoiceId) }).session(session);
            if (!invoice) throw new Error('Invoice not found');
            if (['paid', 'cancelled'].includes(invoice.status)) throw new Error(`Invoice is already ${invoice.status}`);

            const paidAmount = sanitizeAmount(invoice.total);
            const platformFee = sanitizeAmount(paidAmount * 0.015);
            const finalCredit = sanitizeAmount(paidAmount - platformFee);

            const wallet = await Wallet.findOne({ user: invoice.user }).session(session);
            if (!wallet) throw new Error("Merchant wallet not found");

            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const newAvail = currentAvail + finalCredit;

            wallet.availableBalance = String(newAvail);
            wallet.balance = String(sanitizeAmount(wallet.balance) + finalCredit);
            await wallet.save({ session });
            
            const transaction = new Transaction({
                user: invoice.user, type: 'invoice', description: `Invoice Payment Settled: ${invoice.customerName} (#${invoice.invoiceId})`,
                amount: finalCredit, fee: platformFee, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
                status: 'success', provider: sanitizeText(value.paymentMethod) || 'paystack', providerReference: sanitizeText(value.gatewayReference),
                idempotencyKey, invoiceDetails: { invoiceId: invoice.invoiceId, customerEmail: invoice.customerEmail, customerName: invoice.customerName },
                ipAddress: request.ip, userAgent: request.headers['user-agent']
            });
            await transaction.save({ session });
            
            invoice.status = 'paid';
            invoice.paidAt = new Date();
            await invoice.save({ session });

            await createAuditLog({
                user: invoice.user, transactionId: transaction._id, reference: invoice.invoiceId, amount: finalCredit,
                type: 'invoice_settlement', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Invoice Payment API'
            }, session);

            await session.commitTransaction();
            session.endSession();
            
            if (request.server && request.server.io) request.server.io.to(`user:${invoice.user}`).emit('wallet:update', { balance: wallet.availableBalance });
            reply.send({ success: true, message: 'Invoice payment authorized and settled.', transaction });

        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
    } catch (error) { handleError(reply, error, 'Failed to process invoice payment'); }
}

/* ============================================================================
   5. DELETE INVOICE
============================================================================ */
async function deleteInvoice(request, reply) {
    try {
        const { id } = request.params;
        if (!await checkRateLimit(request, 'delete_invoice', 20)) throw { status: 429, message: 'Too many requests.' };

        const deleted = await Invoice.findOneAndDelete({ _id: sanitizeText(id), user: request.user._id });
        if (!deleted) throw { status: 404, message: 'Invoice not found or unauthorized.' };
        
        await createAuditLog({ user: request.user._id, action: `Deleted Invoice: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Invoice permanently deleted from ledger.' });
    } catch (error) { handleError(reply, error, 'System error deleting invoice.'); }
}

/* ============================================================================
   6. MARK INVOICE PAID (MANUAL)
============================================================================ */
async function markInvoicePaid(request, reply) {
    try {
        const { id } = request.params;
        if (!await checkRateLimit(request, 'mark_invoice', 20)) throw { status: 429, message: 'Too many requests.' };

        const updated = await Invoice.findOneAndUpdate(
            { _id: sanitizeText(id), user: request.user._id }, 
            { status: 'paid', paidAt: new Date() }, { new: true }
        );
        if (!updated) throw { status: 404, message: 'Invoice not found or unauthorized.' };
        
        await createAuditLog({ user: request.user._id, action: `Marked Invoice Paid: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Invoice marked as paid.' });
    } catch (error) { handleError(reply, error, 'System error updating status.'); }
}

module.exports = { getInvoices, createInvoice, getInvoice, payInvoice, deleteInvoice, markInvoicePaid };
