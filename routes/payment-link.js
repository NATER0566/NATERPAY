const mongoose = require('mongoose');
const PaymentLink = require('../models/PaymentLink');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const Joi = require('joi'); // [1] Strict Request Validation
const flutterwave = require('../services/flutterwave');
const { settleMerchantPayment } = require('../services/settlement');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

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

let AuditLog, Notification, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

// [3] STRICT MONEY PRECISION HELPER
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount || 0).toFixed(2));
    if (isNaN(num)) return 0;
    return num;
};

// [4] TEXT SANITIZATION (XSS Protection for Public Storefront)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 1000) : '';

// [5] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [6] REDIS / DISTRIBUTED RATE LIMITING ENGINE
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 30) {
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

// [7] IMMUTABLE AUDIT LOGGING ENGINE
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

// Helper Streamifier for Cloudinary
const uploadToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "naterpay_products", resource_type: "image", timeout: 20000 },
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};

/* ============================================================================
   1. GET USER PAYMENT LINKS (DASHBOARD / ADMIN VIEW)
============================================================================ */
async function getLinks(request, reply) {
    try {
        if (!await checkRateLimit(request, 'get_links', 60)) throw { status: 429, message: 'Too many requests.' };

        let query = {};
        if (request.user && request.user.role !== 'admin' && request.user.role !== 'superadmin') {
            query.user = request.user._id;
        }

        const links = await PaymentLink.find(query)
            .populate('user', 'name email')
            .sort({ createdAt: -1 });
        
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
                category: link.category || 'General',
                redirectUrl: link.redirectUrl,
                productImageBase64: link.productImageBase64,
                cloudinaryUrl: link.cloudinaryUrl,
                status: link.status,
                merchantName: link.user ? link.user.name : 'Verified Merchant',
                userEmail: link.user ? link.user.email : 'Unknown',
                user: link.user ? link.user._id : null
            }))
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch payment links'); }
}

/* ============================================================================
   2. CREATE NEW PAYMENT LINK (STOREFRONT PRODUCT)
============================================================================ */
async function createLink(request, reply) {
    try {
        if (!await checkRateLimit(request, 'create_link', 10)) throw { status: 429, message: 'Too many requests. Please wait.' };

        // [8] MARKETPLACE VENDOR ACCESS ENGINE
        const role = (request.user.role || 'user').toLowerCase();
        if (!['reseller', 'agent', 'vip', 'admin', 'superadmin'].includes(role)) {
            throw { 
                status: 403, 
                message: 'Selling on the marketplace is reserved for Verified Vendors to protect buyers from scams. Please upgrade to Reseller or VIP to start selling!' 
            };
        }

        const maxLimit = role === 'vip' ? 50 : (role === 'admin' || role === 'superadmin' ? 99999 : 15);
        const currentProductCount = await PaymentLink.countDocuments({ user: request.user._id });

        if (currentProductCount >= maxLimit) {
            throw { 
                status: 403, 
                message: `Limit Reached: You can only have ${maxLimit} active products on your current plan. Delete older products or upgrade your account to add more slots.` 
            };
        }

        // [1] Strict Joi Validation
        const schema = Joi.object({
            title: Joi.string().required(),
            description: Joi.string().allow('', null),
            amount: Joi.number().min(0).default(0),
            currency: Joi.string().default('NGN'),
            isFlexibleAmount: Joi.boolean().default(false),
            minAmount: Joi.number().allow(null),
            maxAmount: Joi.number().allow(null),
            collectCustomerName: Joi.boolean().default(true),
            collectCustomerEmail: Joi.boolean().default(true),
            collectCustomerPhone: Joi.boolean().default(false),
            maxTransactions: Joi.number().allow(null),
            expiryDate: Joi.date().iso().allow(null),
            redirectUrl: Joi.string().uri().allow('', null),
            productImageBase64: Joi.string().allow('', null),
            category: Joi.string().default('General'),
            whatsapp: Joi.string().allow('', null),
            merchantWhatsApp: Joi.string().allow('', null),
            sellerPhone: Joi.string().allow('', null),
            merchantPhone: Joi.string().allow('', null)
        });

        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const incomingWhatsApp = value.whatsapp || value.merchantWhatsApp || value.sellerPhone || value.merchantPhone;
        if (incomingWhatsApp) {
            await User.findByIdAndUpdate(request.user._id, { whatsapp: sanitizeText(incomingWhatsApp) }).catch(() => {});
        }

        const linkId = 'LN_' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const safeAmount = value.isFlexibleAmount ? 0 : sanitizeAmount(value.amount);

        const paymentLink = new PaymentLink({
            user: request.user._id,
            linkId,
            title: sanitizeText(value.title),
            description: sanitizeText(value.description) || 'Secure NATERPAY Product',
            amount: safeAmount,
            currency: sanitizeText(value.currency) || 'NGN',
            isFlexibleAmount: value.isFlexibleAmount,
            minAmount: value.isFlexibleAmount ? value.minAmount : null,
            maxAmount: value.isFlexibleAmount ? value.maxAmount : null,
            collectCustomerName: value.collectCustomerName,
            collectCustomerEmail: value.collectCustomerEmail,
            collectCustomerPhone: value.collectCustomerPhone,
            maxTransactions: value.maxTransactions || null,
            expiryDate: value.expiryDate || null,
            category: sanitizeText(value.category) || 'General',
            redirectUrl: value.redirectUrl || '',
            productImageBase64: value.productImageBase64 || null,
            status: 'active'
        });
        
        await paymentLink.save();

        await createAuditLog({
            user: request.user._id, transactionId: paymentLink._id, reference: linkId, amount: safeAmount,
            type: 'product_created', previousBalance: '0', newBalance: '0',
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Storefront API'
        });

        reply.status(201).send({ success: true, message: 'Product published to storefront successfully', linkId: paymentLink.linkId });
    } catch (error) { handleError(reply, error, 'Failed to create storefront link'); }
}

/* ============================================================================
   3. GET PAYMENT LINK BY ID (PUBLIC BUYER VIEW)
============================================================================ */
async function getLink(request, reply) {
    try {
        if (!await checkRateLimit(request, 'get_single_link', 60)) throw { status: 429, message: 'Too many requests.' };

        const { id } = request.params;
        const paymentLink = await PaymentLink.findOne({ linkId: sanitizeText(id) }).populate('user', 'name email whatsapp kycLevel');
        
        if (!paymentLink) throw { status: 404, message: 'Payment link not found' };
        
        if (paymentLink.status === 'paused' || paymentLink.status === 'archived' || !paymentLink.isActive) {
            throw { status: 410, message: 'Product is no longer available' };
        }
        
        if (paymentLink.status === 'soldout' || (paymentLink.totalStock !== null && paymentLink.remainingStock <= 0)) {
            throw { status: 410, message: 'This product is completely sold out.' };
        }

        reply.send({
            success: true,
            link: {
                linkId: paymentLink.linkId,
                title: paymentLink.title,
                description: paymentLink.description,
                amount: paymentLink.amount ? paymentLink.amount.toString() : '0',
                currency: paymentLink.currency,
                isFlexibleAmount: paymentLink.isFlexibleAmount,
                collectCustomerName: paymentLink.collectCustomerName,
                collectCustomerEmail: paymentLink.collectCustomerEmail,
                collectCustomerPhone: paymentLink.collectCustomerPhone,
                merchantName: paymentLink.user ? paymentLink.user.name : 'Merchant',
                merchantWhatsApp: paymentLink.user ? (paymentLink.user.whatsapp || '') : '', 
                kycLevel: paymentLink.user ? paymentLink.user.kycLevel : 0,
                category: paymentLink.category || 'General',
                redirectUrl: paymentLink.redirectUrl,
                productImageBase64: paymentLink.productImageBase64,
                cloudinaryUrl: paymentLink.cloudinaryUrl,
                feePreference: paymentLink.feePreference || 'buyer'
            }
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch payment link details'); }
}

/* ============================================================================
   4. PROCESS LINK PAYMENT (ATOMIC TRANSACTION & CENTRAL FEE ENGINE)
============================================================================ */
async function payLink(request, reply) {
    try {
        if (!await checkRateLimit(request, 'pay_link', 10)) throw { status: 429, message: 'Too many payment requests. Please wait.' };

        const schema = Joi.object({
            amount: Joi.number().min(1).optional(),
            customerName: Joi.string().allow('', null),
            customerEmail: Joi.string().email().allow('', null),
            customerPhone: Joi.string().allow('', null)
        });

        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { id } = request.params;
        const paymentLink = await PaymentLink.findOne({ linkId: sanitizeText(id) });
        if (!paymentLink || !paymentLink.isActive || ['paused', 'archived', 'soldout'].includes(paymentLink.status)) {
            throw { status: 410, message: 'Product is no longer available' };
        }
        if (paymentLink.maxTransactions && paymentLink.transactionCount >= paymentLink.maxTransactions) {
            throw { status: 410, message: 'Product transaction limit reached' };
        }
        if (paymentLink.totalStock !== null && paymentLink.remainingStock <= 0) {
            throw { status: 410, message: 'Product sold out' };
        }

        const paymentAmount = sanitizeAmount(value.amount ?? paymentLink.amount);
        if (!paymentLink.isFlexibleAmount && paymentAmount !== sanitizeAmount(paymentLink.amount)) {
            throw { status: 400, message: 'The payment amount does not match this payment link.' };
        }
        if (paymentLink.isFlexibleAmount &&
            ((paymentLink.minAmount !== null && paymentAmount < sanitizeAmount(paymentLink.minAmount)) ||
             (paymentLink.maxAmount !== null && paymentAmount > sanitizeAmount(paymentLink.maxAmount)))) {
            throw { status: 400, message: 'The payment amount is outside this link’s allowed range.' };
        }
        if (paymentAmount <= 0 || !value.customerEmail) throw { status: 400, message: 'A valid payment amount and customer email are required.' };

        const gatewayFee = Math.min(2000, sanitizeAmount(paymentAmount < 2500 ? paymentAmount * 0.015 : paymentAmount * 0.015 + 100));
        const platformFee = sanitizeAmount(paymentAmount * 0.025);
        const merchantCredit = sanitizeAmount(paymentAmount - gatewayFee - platformFee);
        const reference = `NPL${Date.now()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        const transaction = await Transaction.create({
            user: paymentLink.user,
            type: 'payment_link',
            description: `Marketplace payment: ${paymentLink.title}`,
            amount: merchantCredit,
            fee: sanitizeAmount(gatewayFee + platformFee),
            balanceBefore: '0',
            balanceAfter: '0',
            status: 'pending',
            provider: 'flutterwave',
            providerReference: reference,
            idempotencyKey: `plink_${reference}`,
            paymentLinkDetails: { linkId: paymentLink.linkId, customerEmail: value.customerEmail, customerName: sanitizeText(value.customerName) || 'Anonymous' },
            metadata: { linkId: paymentLink.linkId, grossAmount: paymentAmount, merchantCredit, gatewayFee, platformFee, currency: paymentLink.currency },
            ipAddress: request.ip,
            userAgent: request.headers['user-agent']
        });

        try {
            const initialized = await flutterwave.initializePayment({
                amount: paymentAmount,
                currency: paymentLink.currency || 'NGN',
                reference,
                method: 'card',
                customer: { email: value.customerEmail, name: value.customerName, phonenumber: value.customerPhone },
                redirectUrl: `${process.env.APP_URL || ''}/pay.html?tx_ref=${encodeURIComponent(reference)}`
            });
            transaction.providerResponse = initialized.rawResponse || initialized;
            await transaction.save({ validateBeforeSave: false });
            return reply.send({ success: true, status: 'pending', paymentReference: reference, checkoutUrl: initialized.link });
        } catch (error) {
            if (error.code !== 'ECONNABORTED' && error.code !== 'ETIMEDOUT') {
                transaction.status = 'failed';
                await transaction.save({ validateBeforeSave: false });
            }
            throw error;
        }

    } catch (error) { handleError(reply, error, 'Failed to process payment fulfillment'); }
}

async function verifyLinkPayment(request, reply) {
    try {
        const tx = await Transaction.findOne({
            providerReference: request.query?.tx_ref,
            type: 'payment_link',
            provider: 'flutterwave'
        });
        if (!tx || (tx.metadata?.get?.('linkId') || tx.metadata?.linkId) !== sanitizeText(request.params.id)) {
            return reply.code(404).send({ success: false, message: 'Payment transaction not found.' });
        }
        if (tx.status === 'success') return reply.send({ success: true, status: 'success', transaction: tx });
        const verification = await flutterwave.verifyTransaction(tx);
        if (verification.status === 'success' && verification.verified) {
            const settled = await settleMerchantPayment(tx._id, request);
            return reply.send({ success: true, status: 'success', settled: settled.settled });
        }
        if (verification.status === 'failed' || verification.status === 'cancelled') {
            tx.status = verification.status;
            await tx.save({ validateBeforeSave: false });
        }
        return reply.send({ success: true, status: verification.status || 'pending' });
    } catch (error) { return handleError(reply, error, 'Unable to verify payment.'); }
}

/* ============================================================================
   5. GET ALL ACTIVE MARKETPLACE PRODUCTS GLOBALLY
============================================================================ */
async function getAllMarketplaceLinks(request, reply) {
    try {
        if (!await checkRateLimit(request, 'get_global_marketplace', 60)) throw { status: 429, message: 'Too many requests.' };

        const links = await PaymentLink.find({ status: 'active', isActive: true })
            .populate('user', 'name email whatsapp kycLevel')
            .sort({ createdAt: -1 });
        
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
                transactionCount: link.transactionCount || 0,
                category: link.category || 'General',
                productImageBase64: link.productImageBase64,
                cloudinaryUrl: link.cloudinaryUrl,
                merchantName: link.user ? link.user.name : 'Verified Merchant',
                email: link.user ? link.user.email : 'Not Provided',
                whatsapp: link.user ? link.user.whatsapp : 'Not Provided',
                kycLevel: link.user ? link.user.kycLevel : 0
            }))
        });
    } catch (error) { handleError(reply, error, 'Failed to sync the global marketplace ledger'); }
}

/* ============================================================================
   6. SELLER STUDIO: GET USER'S OWN PRODUCTS
============================================================================ */
async function getMyProducts(request, reply) {
    try {
        if (!await checkRateLimit(request, 'get_my_products', 30)) throw { status: 429, message: 'Too many requests.' };

        const links = await PaymentLink.find({ user: request.user._id }).sort({ createdAt: -1 });
        reply.send({ success: true, links });
    } catch (error) { handleError(reply, error, 'Failed to fetch your products'); }
}

/* ============================================================================
   7. CREATE PRODUCT VIA MULTIPART BINARY STREAM (ATOMIC & HARDENED)
============================================================================ */
async function createProductMultipart(request, reply) {
    try {
        if (!await checkRateLimit(request, 'create_product_multipart', 10)) throw { status: 429, message: 'Too many requests. Please wait.' };

        // Vendor Role & Limit Check
        const role = (request.user.role || 'user').toLowerCase();
        if (!['reseller', 'agent', 'vip', 'admin', 'superadmin'].includes(role)) {
            throw { status: 403, message: 'Selling on the marketplace is reserved for Verified Vendors. Upgrade to Reseller or VIP to start selling!' };
        }

        const maxLimit = role === 'vip' ? 50 : (role === 'admin' || role === 'superadmin' ? 99999 : 15);
        const currentProductCount = await PaymentLink.countDocuments({ user: request.user._id });

        if (currentProductCount >= maxLimit) {
            throw { status: 403, message: `Limit Reached: Maximum of ${maxLimit} active products allowed on your current plan.` };
        }

        const parts = request.parts();
        let productData = {};
        let fileBuffer = null;

        for await (const part of parts) {
            if (part.file) {
                fileBuffer = await part.toBuffer();
            } else {
                productData[part.fieldname] = part.value;
            }
        }

        // [1] Joi Validation on Extracted Parts
        const schema = Joi.object({
            title: Joi.string().required(),
            category: Joi.string().default('Product'),
            description: Joi.string().allow('', null),
            amount: Joi.number().min(0).default(0),
            isFlexibleAmount: Joi.string().valid('true', 'false').default('false'),
            status: Joi.string().valid('active', 'paused', 'archived').default('active'),
            feePreference: Joi.string().valid('buyer', 'seller').default('buyer'),
            totalStock: Joi.string().allow('', null, 'null'),
            redirectUrl: Joi.string().uri().allow('', null)
        });

        const { error, value } = schema.validate(productData, { stripUnknown: true });
        if (error) throw error;

        let uploadedMediaUrl = '';

        if (fileBuffer) {
            const maxFileSize = 10 * 1024 * 1024; // 10MB limit
            if (fileBuffer.length > maxFileSize) throw new Error('File size exceeds the 10MB limit.');

            uploadedMediaUrl = await uploadToCloudinary(fileBuffer);
        }

        let stock = null;
        if (value.totalStock && value.totalStock !== 'null' && value.totalStock !== '') {
            stock = parseInt(value.totalStock);
            if (isNaN(stock) || stock < 0) stock = null;
        }

        const linkId = 'LN_' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const isFlexible = value.isFlexibleAmount === 'true';
        const safeAmount = isFlexible ? 0 : sanitizeAmount(value.amount);

        const newProduct = new PaymentLink({
            user: request.user._id,
            linkId: linkId,
            title: sanitizeText(value.title),
            category: sanitizeText(value.category) || 'Product',
            description: sanitizeText(value.description),
            amount: safeAmount,
            isFlexibleAmount: isFlexible,
            status: value.status || 'active',
            feePreference: value.feePreference || 'buyer',
            totalStock: stock,
            remainingStock: stock,
            redirectUrl: value.redirectUrl || '',
            cloudinaryUrl: uploadedMediaUrl
        });

        await newProduct.save();

        await createAuditLog({
            user: request.user._id, transactionId: newProduct._id, reference: linkId, amount: safeAmount,
            type: 'product_created_multipart', previousBalance: '0', newBalance: '0',
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Storefront Multipart API'
        });

        reply.send({ success: true, message: 'Product created successfully', product: newProduct });

    } catch (error) { handleError(reply, error, 'Failed to create product'); }
}

/* ============================================================================
   8. UPDATE PRODUCT STATUS (ACTIVE, PAUSED, ARCHIVED)
============================================================================ */
async function updateProductStatus(request, reply) {
    try {
        if (!await checkRateLimit(request, 'update_product_status', 20)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            status: Joi.string().valid('active', 'paused', 'archived', 'soldout').required()
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { id } = request.params;

        const product = await PaymentLink.findOne({ _id: sanitizeText(id), user: request.user._id });
        if (!product) throw { status: 404, message: 'Product not found' };

        product.status = value.status;
        await product.save();

        await createAuditLog({
            user: request.user._id, transactionId: product._id, reference: product.linkId, amount: 0,
            type: 'product_status_change', previousBalance: '0', newBalance: '0',
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Status: ${value.status}`
        });

        reply.send({ success: true, message: `Product marked as ${value.status}` });
    } catch (error) { handleError(reply, error, 'Failed to update status'); }
}

/* ============================================================================
   9. DELETE PRODUCT FOREVER (FREES UP PRODUCT SLOT LIMIT)
============================================================================ */
async function deleteProductForever(request, reply) {
    try {
        if (!await checkRateLimit(request, 'delete_product', 10)) throw { status: 429, message: 'Too many requests.' };

        const { id } = request.params;
        const product = await PaymentLink.findOneAndDelete({ _id: sanitizeText(id), user: request.user._id });
        
        if (!product) throw { status: 404, message: 'Product not found' };

        await createAuditLog({
            user: request.user._id, transactionId: product._id, reference: product.linkId, amount: 0,
            type: 'product_deleted', previousBalance: '0', newBalance: '0',
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'Storefront API'
        });

        reply.send({ success: true, message: 'Product permanently deleted. A new slot has been freed up.' });
    } catch (error) { handleError(reply, error, 'Failed to delete product'); }
}

module.exports = {
  getLinks,
  getAllMarketplaceLinks, 
  createLink,
  getLink,
  payLink,
  verifyLinkPayment,
  getMyProducts,
  createProductMultipart,
  updateProductStatus,
  deleteProductForever
};
