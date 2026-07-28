const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  // Reference
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Transaction details
  type: {
    type: String,
    required: true,
    enum: [
      'funding', 'withdrawal', 'transfer', 'airtime', 'data', 'electricity',
      'cable', 'exam', 'education', 'betting', 'bulk_sms', 'insurance', 'pos', 'payment_link', 'qr_payment', 
      'invoice', 'cashback', 'referral_bonus', 'refund', 'charge', 'fee',
      'loan_disbursement', 'loan_repayment', 'savings_deposit', 'savings_withdrawal',
      'escrow_deposit', 'escrow_release', 'virtual_card_fund', 'virtual_card_charge',
      'crypto_sell', 'giftcard_trade', 'airtime_to_cash', 'task_reward', 'spin_win',
      'daily_reward', 'reseller_upgrade', 'merchant_payout', 'api_transaction', 'sms', 'foreign-airtime'
    ]
  },
  
  subtype: {
    type: String,
    default: null
  },
  
  description: {
    type: String,
    required: true
  },
  
  // Amounts (using Decimal128 for money safety)
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  fee: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  balanceBefore: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  balanceAfter: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  // Status
  status: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'success', 'failed', 'reversed', 'cancelled'],
    default: 'pending'
  },
  
  // Provider information
  provider: {
    type: String,
    enum: ['paystack', 'flutterwave', 'monnify', 'vtpass', 'vtugate', 'internal', 'system', null],
    default: null
  },
  
  providerReference: {
    type: String,
    default: null
  },
  
  providerResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Service details (for VTU)
  serviceDetails: {
    phone: String,
    network: String,
    plan: String,
    meterNumber: String,
    cablePackage: String,
    smartcardNumber: String,
    examType: String,
    quantity: Number,
    betAccount: String,
    recipient: String
  },
  
  // Payment link/QR details
  paymentLinkDetails: {
    linkId: String,
    qrCode: String,
    customerEmail: String,
    customerName: String
  },
  
  // Invoice details
  invoiceDetails: {
    invoiceId: String,
    customerEmail: String,
    customerName: String,
    dueDate: Date
  },
  
  // Idempotency
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  
  // Metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  
  // IP and device tracking
  ipAddress: String,
  userAgent: String,
  deviceId: String,
  
  // Fraud detection
  fraudFlag: {
    type: Boolean,
    default: false
  },
  fraudReason: String,
  fraudReviewedAt: Date,
  fraudReviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Reconciliation
  reconciled: {
    type: Boolean,
    default: false
  },
  reconciledAt: Date,
  reconciliationNotes: String
}, {
  timestamps: true
});

// Indexes
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ provider: 1, providerReference: 1 });
transactionSchema.index({ idempotencyKey: 1 });
transactionSchema.index({ createdAt: -1 });

// Virtual for total amount
transactionSchema.virtual('totalAmount').get(function() {
  return (parseFloat(this.amount.toString()) + parseFloat(this.fee.toString())).toFixed(2);
});

// Pre-save middleware
transactionSchema.pre('save', function(next) {
  if (!this.idempotencyKey) {
    this.idempotencyKey = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
  }
  next();
});

// Static methods
transactionSchema.statics.findByUser = function(userId, options = {}) {
  const query = { user: userId };
  if (options.type) query.type = options.type;
  if (options.status) query.status = options.status;
  if (options.startDate) query.createdAt = { $gte: options.startDate };
  if (options.endDate) query.createdAt = { ...query.createdAt, $lte: options.endDate };
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50);
};

transactionSchema.statics.findByProviderReference = function(provider, reference) {
  return this.findOne({ provider, providerReference: reference });
};

transactionSchema.statics.findByIdempotencyKey = function(key) {
  return this.findOne({ idempotencyKey: key });
};

transactionSchema.statics.getPendingTransactions = function() {
  return this.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(100);
};

transactionSchema.statics.getFailedTransactions = function(options = {}) {
  const query = { status: 'failed' };
  if (options.since) query.createdAt = { $gte: options.since };
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50);
};

transactionSchema.statics.getUserStats = function(userId) {
  return this.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: { $toDecimal: '$amount' } },
        totalFee: { $sum: { $toDecimal: '$fee' } },
        count: { $sum: 1 },
        successCount: {
          $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
        }
      }
    }
  ]);
};

// Instance methods
transactionSchema.methods.markAsSuccess = function(providerData = null) {
  this.status = 'success';
  if (providerData) {
    this.providerResponse = providerData;
  }
  return this.save();
};

transactionSchema.methods.markAsFailed = function(reason = null) {
  this.status = 'failed';
  if (reason) {
    this.metadata.set('failureReason', reason);
  }
  return this.save();
};

transactionSchema.methods.reverse = function() {
  this.status = 'reversed';
  return this.save();
};

transactionSchema.methods.markReconciled = function(notes = null) {
  this.reconciled = true;
  this.reconciledAt = new Date();
  if (notes) {
    this.reconciliationNotes = notes;
  }
  return this.save();
};

transactionSchema.methods.flagForFraud = function(reason) {
  this.fraudFlag = true;
  this.fraudReason = reason;
  return this.save();
};

transactionSchema.methods.reviewFraud = function(reviewedBy, approved) {
  this.fraudReviewedAt = new Date();
  this.fraudReviewedBy = reviewedBy;
  if (!approved) {
    this.fraudFlag = false;
    this.fraudReason = null;
  }
  return this.save();
};

// Transform for JSON
transactionSchema.set('toJSON', {
  transform: function(doc, ret) {
    ret.amount = parseFloat(ret.amount.toString()).toFixed(2);
    ret.fee = parseFloat(ret.fee.toString()).toFixed(2);
    ret.balanceBefore = parseFloat(ret.balanceBefore.toString()).toFixed(2);
    ret.balanceAfter = parseFloat(ret.balanceAfter.toString()).toFixed(2);
    return ret;
  }
});

// AUTOMATED CASHBACK ENGINE HAS BEEN PERMANENTLY REMOVED 
// TO PROTECT PROFIT MARGINS AND ENSURE ONLY UPGRADED USERS BENEFIT.

module.exports = mongoose.model('Transaction', transactionSchema);
