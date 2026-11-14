
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },

  phoneNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  password: {
    type: String,
    required: true,
    minlength: 8
  },

  name: {
    type: String,
    required: true,
    trim: true
  },

  isEmailVerified: {
    type: Boolean,
    default: false
  },

  role: {
    type: String,
    enum: ['user', 'agent', 'reseller', 'vip', 'merchant', 'admin', 'superadmin'],
    default: 'user'
  },

  // KYC
  kycLevel: {
    type: Number,
    default: 0,
    enum: [0, 1, 2, 3]
  },

  kycData: {
    bvnEncrypted: String,
    bvnLast4: String,
    ninEncrypted: String,
    ninLast4: String,
    bvnName: String,
    bvnPhoneNumber: String,
    bvnDateOfBirth: Date,
    idType: String,
    idNumber: String,
    idImage: String,
    selfieImage: String,
    address: String,
    city: String,
    state: String,
    country: { type: String, default: 'Nigeria' },
    dateOfBirth: Date,
    gender: String
  },

  kycStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'verified', 'bvn_verified_awaiting_nin', 'bvn_verified_nin_failed'],
    default: 'pending'
  },

  kycVerified: {
    type: Boolean,
    default: false
  },

  bvnVerified: {
    type: Boolean,
    default: false
  },

  ninVerified: {
    type: Boolean,
    default: false
  },

  kycSubmittedAt: Date,
  bvnVerifiedAt: Date,
  ninVerifiedAt: Date,
  kycVerifiedAt: Date,

  // Wallet
  balance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },

  frozenBalance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },

  // Security
  withdrawalPin: String,

  withdrawalPinSet: {
    type: Boolean,
    default: false
  },

  isSecured: {
    type: Boolean,
    default: false
  },

  // Login tracking
  loginAttempts: {
    type: Number,
    default: 0
  },

  lockUntil: Date,
  lastLogin: Date,
  lastLoginIP: String,

  // Referral
  referralCode: {
    type: String,
    unique: true
  },

  referredBy: {
    type: String,
    default: null,
    index: true
  },

  referralBonusPaid: {
    type: Boolean,
    default: false
  },

  cumulativeSpend: {
    type: Number,
    default: 0
  },

  referralCount: {
    type: Number,
    default: 0
  },

  referralBonus: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },

  // Reseller
  isReseller: {
    type: Boolean,
    default: false
  },

  resellerLevel: {
    type: String,
    enum: ['basic', 'silver', 'gold', 'platinum'],
    default: null
  },

  // Merchant
  isMerchant: {
    type: Boolean,
    default: false
  },

  businessName: String,
  businessType: String,
  businessAddress: String,

  // Preferences
  hiddenWidgets: [{
    type: String
  }],

  notificationsEnabled: {
    type: Boolean,
    default: true
  },

  emailNotifications: {
    type: Boolean,
    default: true
  },

  smsNotifications: {
    type: Boolean,
    default: false
  },

  // Status
  isActive: {
    type: Boolean,
    default: true
  },

  isSuspended: {
    type: Boolean,
    default: false
  },

  suspensionReason: String,
  suspendedAt: Date,

  // OTP
  otp: String,
  otpExpiry: Date,

  isVerified: {
    type: Boolean,
    default: false
  },

  // API keys
  apiKeys: [{
    key: String,
    name: String,
    createdAt: { type: Date, default: Date.now },
    lastUsed: Date,
    isActive: { type: Boolean, default: true }
  }],

  // Metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: () => new Map()
  }

}, {
  timestamps: true
});

// Indexes
// email and phoneNumber already have unique indexes.
// referralCode already has a unique index.
// Do not declare those indexes again.
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ createdAt: -1 });

// Virtual for total balance
userSchema.virtual('totalBalance').get(function() {
  return (
    parseFloat(this.balance.toString()) +
    parseFloat(this.frozenBalance.toString())
  ).toFixed(2);
});

// Password hashing
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// Generate referral code
userSchema.pre('save', function() {
  if (!this.referralCode) {
    this.referralCode =
      'NP' +
      require('crypto').randomBytes(4).toString('hex').toUpperCase();
  }
});

// Instance methods
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.compareWithdrawalPin = async function(candidatePin) {
  if (!this.withdrawalPin) return false;

  return bcrypt.compare(candidatePin, this.withdrawalPin);
};

userSchema.methods.incrementLoginAttempts = function() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockUntil: 1, loginAttempts: 1 }
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };

  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = {
      lockUntil: Date.now() + 30 * 60 * 1000
    };
  }

  return this.updateOne(updates);
};

userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $unset: { lockUntil: 1, loginAttempts: 1 }
  });
};

userSchema.methods.setWithdrawalPin = async function(pin) {
  const salt = await bcrypt.genSalt(12);

  this.withdrawalPin = await bcrypt.hash(pin, salt);
  this.withdrawalPinSet = true;

  return this.save();
};

userSchema.methods.generateOTP = function() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  this.otp = otp;
  this.otpExpiry = Date.now() + 5 * 60 * 1000;

  return this.save();
};

userSchema.methods.verifyOTP = function(otp) {
  if (!this.otp || !this.otpExpiry) return false;
  if (Date.now() > this.otpExpiry) return false;

  return this.otp === otp;
};

userSchema.methods.consumeOTP = function() {
  this.otp = undefined;
  this.otpExpiry = undefined;
  this.isVerified = true;

  return this.save();
};

userSchema.methods.generateApiKey = function(name) {
  const key =
    'np_' + require('crypto').randomBytes(32).toString('hex');

  this.apiKeys.push({
    key,
    name: name || 'Default API Key',
    createdAt: new Date(),
    isActive: true
  });

  return this.save();
};

userSchema.methods.revokeApiKey = function(keyId) {
  const keyIndex = this.apiKeys.findIndex(
    key => key._id.toString() === keyId
  );

  if (keyIndex > -1) {
    this.apiKeys[keyIndex].isActive = false;
    return this.save();
  }

  return Promise.resolve(this);
};

// Static methods
userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email.toLowerCase() });
};

userSchema.statics.findByPhoneNumber = function(phone) {
  return this.findOne({ phoneNumber: phone });
};

userSchema.statics.findByReferralCode = function(code) {
  return this.findOne({ referralCode: code.toUpperCase() });
};

userSchema.statics.getReferralTree = async function(userId) {
  const user = await this.findById(userId);

  if (!user) return [];

  return this.find({ referredBy: user.referralCode })
    .select('name email phoneNumber referralCount createdAt cumulativeSpend referralBonusPaid')
    .sort({ createdAt: -1 });
};

// JSON transformation
userSchema.set('toJSON', {
  transform: function(doc, ret) {
    delete ret.password;
    delete ret.withdrawalPin;
    delete ret.otp;
    delete ret.__v;

    return ret;
  }
});

module.exports = mongoose.model('User', userSchema);
