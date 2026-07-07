const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  title: {
    type: String,
    required: true
  },
  
  message: {
    type: String,
    required: true
  },
  
  type: {
    type: String,
    enum: ['transaction', 'security', 'system', 'promotion', 'kyc', 'support', 'merchant', 'referral'],
    default: 'system'
  },
  
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  
  // Action link
  actionLink: {
    type: String,
    default: null
  },
  
  actionLabel: {
    type: String,
    default: null
  },
  
  // Status
  isRead: {
    type: Boolean,
    default: false
  },
  
  readAt: Date,
  
  // Channels
  channels: [{
    type: String,
    enum: ['in_app', 'email', 'sms'],
    default: ['in_app']
  }],
  
  // Delivery status
  emailSent: {
    type: Boolean,
    default: false
  },
  
  emailSentAt: Date,
  
  smsSent: {
    type: Boolean,
    default: false
  },
  
  smsSentAt: Date,
  
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
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

// Instance methods
notificationSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

notificationSchema.methods.markEmailSent = function() {
  this.emailSent = true;
  this.emailSentAt = new Date();
  return this.save();
};

notificationSchema.methods.markSmsSent = function() {
  this.smsSent = true;
  this.smsSentAt = new Date();
  return this.save();
};

// Static methods
notificationSchema.statics.findByUser = function(userId, options = {}) {
  const query = { user: userId };
  if (options.unreadOnly) query.isRead = false;
  if (options.type) query.type = options.type;
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50);
};

notificationSchema.statics.findUnreadCount = function(userId) {
  return this.countDocuments({ user: userId, isRead: false });
};

notificationSchema.statics.markAllAsRead = function(userId) {
  return this.updateMany(
    { user: userId, isRead: false },
    { isRead: true, readAt: new Date() }
  );
};

module.exports = mongoose.model('Notification', notificationSchema);
