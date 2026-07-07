const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  ticketId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  subject: {
    type: String,
    required: true
  },
  
  category: {
    type: String,
    enum: ['transaction', 'account', 'kyc', 'payment', 'technical', 'feature_request', 'bug_report', 'other'],
    default: 'other'
  },
  
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  
  description: {
    type: String,
    required: true
  },
  
  // Status
  status: {
    type: String,
    enum: ['open', 'in_progress', 'waiting', 'resolved', 'closed'],
    default: 'open'
  },
  
  // Assigned to
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  assignedAt: Date,
  
  // Resolution
  resolution: String,
  resolvedAt: Date,
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Messages
  messages: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    message: {
      type: String,
      required: true
    },
    isInternal: {
      type: Boolean,
      default: false
    },
    attachments: [String],
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Related transaction
  relatedTransaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  
  // Satisfaction
  satisfactionRating: {
    type: Number,
    min: 1,
    max: 5
  },
  
  satisfactionComment: String,
  
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
supportTicketSchema.index({ user: 1, status: 1 });
supportTicketSchema.index({ ticketId: 1 });
supportTicketSchema.index({ status: 1, priority: 1 });
supportTicketSchema.index({ assignedTo: 1 });

// Pre-save middleware
supportTicketSchema.pre('save', function(next) {
  if (!this.ticketId) {
    this.ticketId = 'tk_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  next();
});

// Instance methods
supportTicketSchema.methods.addMessage = function(userId, message, isInternal = false, attachments = []) {
  this.messages.push({
    user: userId,
    message,
    isInternal,
    attachments,
    createdAt: new Date()
  });
  return this.save();
};

supportTicketSchema.methods.assignTo = function(adminId) {
  this.assignedTo = adminId;
  this.assignedAt = new Date();
  this.status = 'in_progress';
  return this.save();
};

supportTicketSchema.methods.setStatus = function(status) {
  this.status = status;
  if (status === 'resolved') {
    this.resolvedAt = new Date();
  }
  return this.save();
};

supportTicketSchema.methods.resolve = function(resolution, resolvedBy) {
  this.status = 'resolved';
  this.resolution = resolution;
  this.resolvedAt = new Date();
  this.resolvedBy = resolvedBy;
  return this.save();
};

supportTicketSchema.methods.close = function() {
  this.status = 'closed';
  return this.save();
};

supportTicketSchema.methods.reopen = function() {
  this.status = 'open';
  this.resolution = null;
  this.resolvedAt = null;
  this.resolvedBy = null;
  return this.save();
};

supportTicketSchema.methods.setSatisfaction = function(rating, comment = null) {
  this.satisfactionRating = rating;
  if (comment) this.satisfactionComment = comment;
  return this.save();
};

// Static methods
supportTicketSchema.statics.findByUser = function(userId) {
  return this.find({ user: userId })
    .sort({ createdAt: -1 });
};

supportTicketSchema.statics.findByTicketId = function(ticketId) {
  return this.findOne({ ticketId })
    .populate('user', 'name email phoneNumber')
    .populate('assignedTo', 'name email')
    .populate('messages.user', 'name email role');
};

supportTicketSchema.statics.findOpen = function() {
  return this.find({ status: 'open' })
    .populate('user', 'name email phoneNumber')
    .sort({ priority: -1, createdAt: 1 });
};

supportTicketSchema.statics.findByAdmin = function(adminId) {
  return this.find({ assignedTo: adminId })
    .populate('user', 'name email phoneNumber')
    .sort({ status: 1, createdAt: -1 });
};

supportTicketSchema.statics.findByStatus = function(status) {
  return this.find({ status })
    .populate('user', 'name email phoneNumber')
    .sort({ priority: -1, createdAt: 1 });
};

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
