const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false, // Changed to false so Global Announcements can be saved
    index: true
  },
  
  isGlobal: {
    type: Boolean,
    default: false, // True means ALL users will see this
    index: true
  },

  image: {
    type: String,
    default: null // Explicitly allows Cloudinary image URLs
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
    enum: ['transaction', 'security', 'system', 'promotion', 'kyc', 'support', 'merchant', 'referral', 'info'],
    default: 'system'
  },
  
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  
  actionLink: { type: String, default: null },
  actionLabel: { type: String, default: null },
  
  isRead: { type: Boolean, default: false },
  readAt: Date,
  
  channels: [{
    type: String,
    enum: ['in_app', 'email', 'sms'],
    default: ['in_app']
  }],
  
  emailSent: { type: Boolean, default: false },
  emailSentAt: Date,
  smsSent: { type: Boolean, default: false },
  smsSentAt: Date,
  
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

module.exports = mongoose.model('Notification', notificationSchema);
