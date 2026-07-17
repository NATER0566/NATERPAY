const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const paymentLinkSchema = new mongoose.Schema({
    linkId: { type: String, default: uuidv4, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    category: { type: String, default: 'Product' },
    description: { type: String, required: true },
    amount: { type: String, default: '0' },
    currency: { type: String, default: 'NGN' },
    isFlexibleAmount: { type: Boolean, default: false },
    
    // Media & URLs
    cloudinaryUrl: { type: String, default: '' },
    productImageBase64: { type: String }, // Kept for legacy support
    redirectUrl: { type: String, default: '' },
    
    // Enterprise Configuration
    status: { type: String, enum: ['active', 'draft', 'paused', 'soldout', 'archived'], default: 'active' },
    feePreference: { type: String, enum: ['buyer', 'seller'], default: 'buyer' },
    totalStock: { type: Number, default: null },
    remainingStock: { type: Number, default: null },
    collectCustomerPhone: { type: Boolean, default: false },
    
    // Analytics
    views: { type: Number, default: 0 },
    transactionCount: { type: Number, default: 0 },
    totalCollected: { type: Number, default: 0 },
    feesPaid: { type: Number, default: 0 },
    refundCount: { type: Number, default: 0 },
    customers: [{ type: String }],
    
    isActive: { type: Boolean, default: true } // Legacy flag
}, { timestamps: true });

module.exports = mongoose.model('PaymentLink', paymentLinkSchema);
