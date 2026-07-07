const mongoose = require('mongoose');

const paymentLinkSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  linkId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  title: {
    type: String,
    required: true
  },
  
  description: {
    type: String,
    default: null
  },
  
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  currency: {
    type: String,
    default: 'NGN'
  },
  
  // Flexible amount
  isFlexibleAmount: {
    type: Boolean,
    default: false
  },
  
  minAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: null
  },
  
  maxAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: null
  },
  
  // Customer details collection
  collectCustomerName: {
    type: Boolean,
    default: true
  },
  
  collectCustomerEmail: {
    type: Boolean,
    default: true
  },
  
  collectCustomerPhone: {
    type: Boolean,
    default: false
  },
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Limits
  maxTransactions: {
    type: Number,
    default: null
  },
  
  transactionCount: {
    type: Number,
    default: 0
  },
  
  expiryDate: {
    type: Date,
    default: null
  },
  
  // Success redirect
  successUrl: {
    type: String,
    default: null
  },
  
  cancelUrl: {
    type: String,
    default: null
  },
  
  // Metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  }
}, {
  timestamps: true
});

// Indexes
paymentLinkSchema.index({ user: 1, isActive: 1 });
paymentLinkSchema.index({ linkId: 1 });

// Pre-save middleware
paymentLinkSchema.pre('save', function(next) {
  if (!this.linkId) {
    this.linkId = 'pl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
  }
  next();
});

// Instance methods
paymentLinkSchema.methods.incrementTransactionCount = function() {
  this.transactionCount += 1;
  return this.save();
};

paymentLinkSchema.methods.deactivate = function() {
  this.isActive = false;
  return this.save();
};

paymentLinkSchema.methods.activate = function() {
  this.isActive = true;
  return this.save();
};

paymentLinkSchema.methods.isExpired = function() {
  if (!this.expiryDate) return false;
  return new Date() > this.expiryDate;
};

paymentLinkSchema.methods.isMaxReached = function() {
  if (!this.maxTransactions) return false;
  return this.transactionCount >= this.maxTransactions;
};

// Static methods
paymentLinkSchema.statics.findByUser = function(userId) {
  return this.find({ user: userId })
    .sort({ createdAt: -1 });
};

paymentLinkSchema.statics.findByLinkId = function(linkId) {
  return this.findOne({ linkId, isActive: true });
};

paymentLinkSchema.statics.findActiveByUser = function(userId) {
  return this.find({ user: userId, isActive: true })
    .sort({ createdAt: -1 });
};

module.exports = mongoose.model('PaymentLink', paymentLinkSchema);
