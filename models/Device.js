const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  deviceName: {
    type: String,
    default: 'Unknown Device'
  },
  
  deviceType: {
    type: String,
    enum: ['mobile', 'tablet', 'desktop', 'other'],
    default: 'other'
  },
  
  platform: {
    type: String,
    default: null
  },
  
  browser: {
    type: String,
    default: null
  },
  
  ipAddress: {
    type: String,
    required: true
  },
  
  location: {
    country: String,
    city: String,
    region: String,
    latitude: Number,
    longitude: Number
  },
  
  userAgent: {
    type: String,
    required: true
  },
  
  fingerprint: {
    type: String,
    required: true,
    index: true
  },
  
  isTrusted: {
    type: Boolean,
    default: false
  },
  
  isBlocked: {
    type: Boolean,
    default: false
  },
  
  blockReason: String,
  
  lastSeen: {
    type: Date,
    default: Date.now
  },
  
  loginCount: {
    type: Number,
    default: 1
  },
  
  suspiciousActivity: {
    type: Boolean,
    default: false
  },
  
  suspiciousReason: String
}, {
  timestamps: true
});

// Indexes
deviceSchema.index({ user: 1, fingerprint: 1 });
deviceSchema.index({ ipAddress: 1 });
deviceSchema.index({ lastSeen: -1 });

// Instance methods
deviceSchema.methods.recordLogin = function() {
  this.lastSeen = new Date();
  this.loginCount += 1;
  return this.save();
};

deviceSchema.methods.trust = function() {
  this.isTrusted = true;
  return this.save();
};

deviceSchema.methods.untrust = function() {
  this.isTrusted = false;
  return this.save();
};

deviceSchema.methods.block = function(reason = null) {
  this.isBlocked = true;
  if (reason) this.blockReason = reason;
  return this.save();
};

deviceSchema.methods.unblock = function() {
  this.isBlocked = false;
  this.blockReason = null;
  return this.save();
};

deviceSchema.methods.flagSuspicious = function(reason) {
  this.suspiciousActivity = true;
  this.suspiciousReason = reason;
  return this.save();
};

// Static methods
deviceSchema.statics.findByUser = function(userId) {
  return this.find({ user: userId })
    .sort({ lastSeen: -1 });
};

deviceSchema.statics.findByFingerprint = function(fingerprint) {
  return this.findOne({ fingerprint });
};

deviceSchema.statics.findTrustedDevices = function(userId) {
  return this.find({ user: userId, isTrusted: true })
    .sort({ lastSeen: -1 });
};

deviceSchema.statics.findBlockedDevices = function(userId) {
  return this.find({ user: userId, isBlocked: true })
    .sort({ lastSeen: -1 });
};

module.exports = mongoose.model('Device', deviceSchema);
