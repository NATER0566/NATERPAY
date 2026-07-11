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
  
  // Amounts (using Decimal128 for money safety)
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  currency: {
    type: String,
    default: 'NGN'
  },
  
  // Flexible amount settings
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
  
  // Customer details collection settings
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
  
  // Status and Tracking
  isActive: {
    type: Boolean,
    default: true
  },
  
  maxTransactions: {
    type: Number,
    default: null
  },
  
  transactionCount: {
    type: Number,
    default: 0
  },
  
  totalCollected: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  expiryDate: {
    type: Date,
    default: null
  },
  
  // Custom Success/Cancel redirects
  successUrl: {
    type: String,
    default: null
  },
  
  cancelUrl: {
    type: String,
    default: null
  },
  
  // Metadata for extensibility
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  }
}, {
  timestamps: true
});

// Indexes for fast querying
paymentLinkSchema.index({ user: 1, isActive: 1 });
paymentLinkSchema.index({ linkId: 1 });

// Pre-save middleware to auto-generate linkId if not provided by the route
paymentLinkSchema.pre('save', function(next) {
  if (!this.linkId) {
    this.linkId = 'pl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
  }
  next();
});

// Instance methods
paymentLinkSchema.methods.incrementTransactionCount = function(paidAmount = 0) {
  this.transactionCount += 1;
  this.totalCollected = (parseFloat(this.totalCollected.toString()) + parseFloat(paidAmount)).toString();
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
  return this.find({ user: userId }).sort({ createdAt: -1 });
};

paymentLinkSchema.statics.findByLinkId = function(linkId) {
  return this.findOne({ linkId, isActive: true });
};

paymentLinkSchema.statics.findActiveByUser = function(userId) {
  return this.find({ user: userId, isActive: true }).sort({ createdAt: -1 });
};

// Convert Decimal128 to pure numbers for the frontend to prevent crashing the UI
paymentLinkSchema.set('toJSON', {
  transform: function(doc, ret) {
    if (ret.amount) ret.amount = parseFloat(ret.amount.toString()).toFixed(2);
    if (ret.minAmount) ret.minAmount = parseFloat(ret.minAmount.toString()).toFixed(2);
    if (ret.maxAmount) ret.maxAmount = parseFloat(ret.maxAmount.toString()).toFixed(2);
    if (ret.totalCollected) ret.totalCollected = parseFloat(ret.totalCollected.toString()).toFixed(2);
    return ret;
  }
});

module.exports = mongoose.model('PaymentLink', paymentLinkSchema);
