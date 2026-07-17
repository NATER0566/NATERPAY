  const mongoose = require('mongoose');
const PaymentLink = require('../models/PaymentLink');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Configure Cloudinary using your existing env variables
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Conditionally load these to prevent crashes if files are missing/renamed
let AuditLog, Notification, generateIdempotencyKey;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { generateIdempotencyKey = require('../utils/auth').generateIdempotencyKey; } catch(e) {}

/**
 * 1. Get user's payment links (Dashboard View / Admin View) - LEGACY SUPPORT
 */
async function getLinks(request, reply) {
  try {
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
  } catch (error) {
    console.error('Get payment links error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch payment links' });
  }
}

/**
 * 2. Create a new payment link (Storefront Product) - LEGACY JSON SUPPORT
 */
async function createLink(request, reply) {
  try {
    const { 
        title, description, amount, currency, isFlexibleAmount, 
        minAmount, maxAmount, collectCustomerName, collectCustomerEmail, 
        collectCustomerPhone, maxTransactions, expiryDate, 
        redirectUrl, productImageBase64, category 
    } = request.body;
    
    if (!title) return reply.status(400).send({ success: false, message: 'Product title is required' });

    const incomingWhatsApp = request.body.whatsapp || request.body.merchantWhatsApp || request.body.sellerPhone || request.body.merchantPhone;
    if (incomingWhatsApp && request.user && request.user._id) {
      try {
        const User = mongoose.models.User || mongoose.model('User');
        await User.findByIdAndUpdate(request.user._id, { whatsapp: incomingWhatsApp.trim() });
      } catch (userUpdateErr) {}
    }

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
      category: category || 'General',
      redirectUrl: redirectUrl || '',
      productImageBase64: productImageBase64 || null,
      status: 'active'
    });
    
    await paymentLink.save();
    
    reply.status(201).send({ success: true, message: 'Product published to storefront successfully', linkId: paymentLink.linkId });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to create storefront link' });
  }
}

/**
 * 3. Get payment link by ID (Public Customer View loaded by pay.html)
 */
async function getLink(request, reply) {
  try {
    const { id } = request.params;
    const paymentLink = await PaymentLink.findOne({ linkId: id }).populate('user', 'name email whatsapp');
    
    if (!paymentLink) return reply.status(404).send({ success: false, message: 'Payment link not found' });
    
    if (paymentLink.status === 'paused' || paymentLink.status === 'archived' || !paymentLink.isActive) {
      return reply.status(410).send({ success: false, message: 'Product is no longer available' });
    }
    
    if (paymentLink.status === 'soldout' || (paymentLink.totalStock !== null && paymentLink.remainingStock <= 0)) {
      return reply.status(410).send({ success: false, message: 'This product is completely sold out.' });
    }
    
    reply.send({
      success: true,
      paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY, 
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
        category: paymentLink.category || 'General',
        redirectUrl: paymentLink.redirectUrl,
        productImageBase64: paymentLink.productImageBase64,
        cloudinaryUrl: paymentLink.cloudinaryUrl,
        feePreference: paymentLink.feePreference || 'buyer'
      }
    });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to fetch payment link details' });
  }
}

/**
 * 4. Process the Link Payment (Stock Engine & Fee Preference Routing)
 */
async function payLink(request, reply) {
  try {
    const { id } = request.params;
    const { customerName, customerEmail, gatewayReference, paymentMethod } = request.body;
    
    const paymentAmount = parseFloat(request.body.amount || request.body.paidAmount || 0);
    const paymentLink = await PaymentLink.findOne({ linkId: id });
    
    if (!paymentLink) return reply.status(404).send({ success: false, message: 'Product route missing' });
    if (paymentLink.status === 'paused' || paymentLink.status === 'archived') return reply.status(410).send({ success: false, message: 'Product is no longer available' });
    if (paymentLink.status === 'soldout') return reply.status(410).send({ success: false, message: 'Product sold out' });
    
    // --- ENTERPRISE FEE ENGINE ---
    const platformFee = paymentAmount * 0.025; 
    let finalCredit = paymentAmount - platformFee;

    // If seller set fee to 'buyer', ensure they receive full exact product price
    if (paymentLink.feePreference === 'buyer' && !paymentLink.isFlexibleAmount) {
        finalCredit = parseFloat(paymentLink.amount);
    }
    // -----------------------------

    const wallet = await Wallet.findOne({ user: paymentLink.user });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Merchant wallet not found' });

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    wallet.availableBalance = String(currentAvail + finalCredit);
    wallet.balance = String(parseFloat(wallet.balance?.toString() || '0') + finalCredit);
    await wallet.save();

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
      paymentLinkDetails: { linkId: paymentLink.linkId, customerEmail: customerEmail || null, customerName: customerName || null }
    });
    await transaction.save();
    
    // --- STOCK DECREMENT & ANALYTICS ENGINE ---
    paymentLink.transactionCount = (paymentLink.transactionCount || 0) + 1;
    paymentLink.totalCollected = (parseFloat(paymentLink.totalCollected?.toString() || '0') + paymentAmount).toString();
    paymentLink.feesPaid = (paymentLink.feesPaid || 0) + (paymentAmount - finalCredit);

    if (paymentLink.totalStock !== null && paymentLink.totalStock > 0) {
        paymentLink.remainingStock = (paymentLink.remainingStock !== null ? paymentLink.remainingStock : paymentLink.totalStock) - 1;
        if (paymentLink.remainingStock <= 0) {
            paymentLink.remainingStock = 0;
            paymentLink.status = 'soldout';
        }
    }
    await paymentLink.save();
    
    // Notifications
    if (Notification && typeof Notification.create === 'function') {
      await Notification.create({ user: paymentLink.user, title: 'Product Sale!', message: `₦${finalCredit.toLocaleString()} received via storefront: ${paymentLink.title}`, type: 'transaction', priority: 'high' }).catch(e=>e);
    }
    
    if (request.server && request.server.io) {
      request.server.io.to(`user:${paymentLink.user}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      request.server.io.to(`user:${paymentLink.user}`).emit('notification', { type: 'success', title: 'New Sale!', message: `You received ₦${finalCredit.toLocaleString()} from: ${paymentLink.title}` });
    }
    
    reply.send({ success: true, message: 'Payment verified and settled.', transaction, redirectUrl: paymentLink.redirectUrl });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to process payment fulfillment' });
  }
}

/**
 * 5. Get ALL active payment links globally
 */
async function getAllMarketplaceLinks(request, reply) {
  try {
    const links = await PaymentLink.find({ status: 'active', isActive: true })
      .populate('user', 'name email whatsapp')
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
        whatsapp: link.user ? link.user.whatsapp : 'Not Provided'
      }))
    });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to sync the global marketplace ledger' });
  }
}

// ============================================================================
// NEW ENTERPRISE SELLER STUDIO ROUTES
// ============================================================================

// 6. Get Logged-In User's Products with Enterprise Analytics
async function getMyProducts(request, reply) {
    try {
        const links = await PaymentLink.find({ user: request.user._id }).sort({ createdAt: -1 });
        reply.send({ success: true, links });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to fetch your products' });
    }
}

// 7. Create Enterprise Product (Multipart Binary/Cloudinary stream)
async function createProductMultipart(request, reply) {
    try {
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

        let uploadedMediaUrl = '';

        if (fileBuffer) {
            uploadedMediaUrl = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    { folder: "naterpay_products", resource_type: "image" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result.secure_url);
                    }
                );
                streamifier.createReadStream(fileBuffer).pipe(uploadStream);
            });
        }

        let stock = null;
        if (productData.totalStock && productData.totalStock !== 'null' && productData.totalStock !== '') {
            stock = parseInt(productData.totalStock);
        }

        const linkId = 'LN_' + crypto.randomBytes(5).toString('hex').toUpperCase();

        const newProduct = new PaymentLink({
            user: request.user._id,
            linkId: linkId,
            title: productData.title,
            category: productData.category || 'Product',
            description: productData.description,
            amount: productData.amount || '0',
            isFlexibleAmount: productData.isFlexibleAmount === 'true',
            status: productData.status || 'active',
            feePreference: productData.feePreference || 'buyer',
            totalStock: stock,
            remainingStock: stock,
            redirectUrl: productData.redirectUrl || '',
            cloudinaryUrl: uploadedMediaUrl
        });

        await newProduct.save();
        reply.send({ success: true, message: 'Product created successfully', product: newProduct });

    } catch (error) {
        console.error("Multipart Product Error:", error);
        reply.status(500).send({ success: false, message: 'Failed to create product' });
    }
}

// 8. Update Status (Active, Paused, Archived)
async function updateProductStatus(request, reply) {
    try {
        const { id } = request.params;
        const { status } = request.body;

        const product = await PaymentLink.findOne({ _id: id, user: request.user._id });
        if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });

        product.status = status;
        await product.save();

        reply.send({ success: true, message: `Product marked as ${status}` });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to update status' });
    }
}

// 9. Delete Forever
async function deleteProductForever(request, reply) {
    try {
        const { id } = request.params;
        const product = await PaymentLink.findOneAndDelete({ _id: id, user: request.user._id });
        
        if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });

        reply.send({ success: true, message: 'Product permanently deleted' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to delete product' });
    }
}

module.exports = {
  getLinks,
  getAllMarketplaceLinks, 
  createLink,
  getLink,
  payLink,
  getMyProducts,
  createProductMultipart,
  updateProductStatus,
  deleteProductForever
};

