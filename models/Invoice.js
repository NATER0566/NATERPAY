const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  invoiceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  customerName: {
    type: String,
    required: true
  },
  
  customerEmail: {
    type: String,
    required: true
  },
  
  customerPhone: {
    type: String,
    default: null
  },
  
  items: [{
    description: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      default: 1
    },
    unitPrice: {
      type: mongoose.Schema.Types.Decimal128,
      required: true
    },
    total: {
      type: mongoose.Schema.Types.Decimal128,
      required: true
    }
  }],
  
  subtotal: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  tax: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  taxRate: {
    type: Number,
    default: 0
  },
  
  discount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  discountRate: {
    type: Number,
    default: 0
  },
  
  total: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  
  currency: {
    type: String,
    default: 'NGN'
  },
  
  dueDate: {
    type: Date,
    required: true
  },
  
  notes: {
    type: String,
    default: null
  },
  
  status: {
    type: String,
    enum: ['draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'],
    default: 'draft'
  },
  
  paidAt: Date,
  
  paymentReference: String,
  
  paymentMethod: String,
  
  // Reminder settings
  remindersEnabled: {
    type: Boolean,
    default: true
  },
  
  reminderSent: {
    type: Boolean,
    default: false
  },
  
  reminderSentAt: Date,
  
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
invoiceSchema.index({ user: 1, status: 1 });
invoiceSchema.index({ invoiceId: 1 });
invoiceSchema.index({ dueDate: 1 });

// Pre-save middleware
invoiceSchema.pre('save', function(next) {
  if (!this.invoiceId) {
    this.invoiceId = 'inv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
  }
  next();
});

// Instance methods
invoiceSchema.methods.markAsSent = function() {
  this.status = 'sent';
  return this.save();
};

invoiceSchema.methods.markAsViewed = function() {
  this.status = 'viewed';
  return this.save();
};

invoiceSchema.methods.markAsPaid = function(paymentReference, paymentMethod) {
  this.status = 'paid';
  this.paidAt = new Date();
  this.paymentReference = paymentReference;
  this.paymentMethod = paymentMethod;
  return this.save();
};

invoiceSchema.methods.markAsOverdue = function() {
  this.status = 'overdue';
  return this.save();
};

invoiceSchema.methods.cancel = function() {
  this.status = 'cancelled';
  return this.save();
};

invoiceSchema.methods.sendReminder = function() {
  this.reminderSent = true;
  this.reminderSentAt = new Date();
  return this.save();
};

invoiceSchema.methods.isOverdue = function() {
  return this.dueDate < new Date() && !['paid', 'cancelled'].includes(this.status);
};

// Static methods
invoiceSchema.statics.findByUser = function(userId) {
  return this.find({ user: userId })
    .sort({ createdAt: -1 });
};

invoiceSchema.statics.findByInvoiceId = function(invoiceId) {
  return this.findOne({ invoiceId });
};

invoiceSchema.statics.findOverdue = function() {
  return this.find({
    status: { $in: ['sent', 'viewed'] },
    dueDate: { $lt: new Date() }
  });
};

invoiceSchema.statics.findPending = function(userId) {
  return this.find({
    user: userId,
    status: { $in: ['sent', 'viewed'] }
  })
    .sort({ dueDate: 1 });
};

module.exports = mongoose.model('Invoice', invoiceSchema);
