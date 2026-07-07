const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  
  action: {
    type: String,
    required: true,
    enum: [
      'login', 'logout', 'register', 'password_change', 'pin_change',
      'kyc_submit', 'kyc_approve', 'kyc_reject',
      'transaction_create', 'transaction_success', 'transaction_failed', 'transaction_reverse',
      'funding', 'withdrawal', 'transfer',
      'payment_link_create', 'payment_link_update', 'payment_link_delete',
      'invoice_create', 'invoice_update', 'invoice_delete', 'invoice_paid',
      'api_key_create', 'api_key_revoke',
      'device_trust', 'device_block', 'device_unblock',
      'wallet_freeze', 'wallet_unfreeze',
      'user_suspend', 'user_unsuspend',
      'admin_action', 'system_change'
    ]
  },
  
  description: {
    type: String,
    required: true
  },
  
  // Details
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // IP and device
  ipAddress: String,
  userAgent: String,
  deviceId: String,
  
  // Result
  status: {
    type: String,
    enum: ['success', 'failure', 'pending'],
    default: 'success'
  },
  
  errorMessage: String,
  
  // Admin actions
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
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
auditLogSchema.index({ user: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

// Static methods
auditLogSchema.statics.findByUser = function(userId, options = {}) {
  const query = { user: userId };
  if (options.action) query.action = options.action;
  if (options.startDate) query.createdAt = { $gte: options.startDate };
  if (options.endDate) query.createdAt = { ...query.createdAt, $lte: options.endDate };
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 100);
};

auditLogSchema.statics.findByAction = function(action, options = {}) {
  const query = { action };
  if (options.startDate) query.createdAt = { $gte: options.startDate };
  if (options.endDate) query.createdAt = { ...query.createdAt, $lte: options.endDate };
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 100);
};

auditLogSchema.statics.findByAdmin = function(adminId, options = {}) {
  const query = { performedBy: adminId };
  if (options.startDate) query.createdAt = { $gte: options.startDate };
  if (options.endDate) query.createdAt = { ...query.createdAt, $lte: options.endDate };
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 100);
};

auditLogSchema.statics.logAction = async function(data) {
  return this.create(data);
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
