const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  
  // Balances (using Decimal128 for money safety)
  availableBalance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  frozenBalance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  pendingBalance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  // Limits
  dailyLimit: {
    type: mongoose.Schema.Types.Decimal128,
    default: 500000
  },
  
  dailySpent: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  dailyLimitResetAt: {
    type: Date,
    default: Date.now
  },
  
  // PIN
  pinSet: {
    type: Boolean,
    default: false
  },
  
  pin: String,
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  
  isFrozen: {
    type: Boolean,
    default: false
  },
  
  freezeReason: String,
  frozenAt: Date,
  
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
walletSchema.index({ user: 1 });

// Virtual for total balance
walletSchema.virtual('totalBalance').get(function() {
  return (parseFloat(this.availableBalance.toString()) + parseFloat(this.frozenBalance.toString())).toFixed(2);
});

// Pre-save middleware
walletSchema.pre('save', function(next) {
  // Reset daily spent if new day
  if (this.dailyLimitResetAt && new Date(this.dailyLimitResetAt).toDateString() !== new Date().toDateString()) {
    this.dailySpent = 0;
    this.dailyLimitResetAt = new Date();
  }
  next();
});

// Instance methods
walletSchema.methods.credit = async function(amount, description = null) {
  const session = await this.startSession();
  session.startTransaction();
  
  try {
    this.availableBalance = (parseFloat(this.availableBalance.toString()) + parseFloat(amount)).toString();
    await this.save({ session });
    await session.commitTransaction();
    session.endSession();
    return this;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

walletSchema.methods.debit = async function(amount, description = null) {
  const session = await this.startSession();
  session.startTransaction();
  
  try {
    if (parseFloat(this.availableBalance.toString()) < parseFloat(amount)) {
      throw new Error('Insufficient balance');
    }
    
    this.availableBalance = (parseFloat(this.availableBalance.toString()) - parseFloat(amount)).toString();
    this.dailySpent = (parseFloat(this.dailySpent.toString()) + parseFloat(amount)).toString();
    await this.save({ session });
    await session.commitTransaction();
    session.endSession();
    return this;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

walletSchema.methods.freeze = async function(amount, reason = null) {
  const session = await this.startSession();
  session.startTransaction();
  
  try {
    if (parseFloat(this.availableBalance.toString()) < parseFloat(amount)) {
      throw new Error('Insufficient balance to freeze');
    }
    
    this.availableBalance = (parseFloat(this.availableBalance.toString()) - parseFloat(amount)).toString();
    this.frozenBalance = (parseFloat(this.frozenBalance.toString()) + parseFloat(amount)).toString();
    if (reason) this.freezeReason = reason;
    await this.save({ session });
    await session.commitTransaction();
    session.endSession();
    return this;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

walletSchema.methods.unfreeze = async function(amount) {
  const session = await this.startSession();
  session.startTransaction();
  
  try {
    if (parseFloat(this.frozenBalance.toString()) < parseFloat(amount)) {
      throw new Error('Insufficient frozen balance');
    }
    
    this.frozenBalance = (parseFloat(this.frozenBalance.toString()) - parseFloat(amount)).toString();
    this.availableBalance = (parseFloat(this.availableBalance.toString()) + parseFloat(amount)).toString();
    await this.save({ session });
    await session.commitTransaction();
    session.endSession();
    return this;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

walletSchema.methods.checkDailyLimit = function(amount) {
  const newDailySpent = parseFloat(this.dailySpent.toString()) + parseFloat(amount);
  return newDailySpent <= parseFloat(this.dailyLimit.toString());
};

walletSchema.methods.setPin = async function(pin) {
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(12);
  this.pin = await bcrypt.hash(pin, salt);
  this.pinSet = true;
  return this.save();
};

walletSchema.methods.verifyPin = async function(pin) {
  if (!this.pin || !this.pinSet) return false;
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(pin, this.pin);
};

walletSchema.methods.freezeWallet = function(reason = null) {
  this.isFrozen = true;
  if (reason) this.freezeReason = reason;
  this.frozenAt = new Date();
  return this.save();
};

walletSchema.methods.unfreezeWallet = function() {
  this.isFrozen = false;
  this.freezeReason = null;
  this.frozenAt = null;
  return this.save();
};

// Static methods
walletSchema.statics.findByUser = function(userId) {
  return this.findOne({ user: userId });
};

// Transform for JSON
walletSchema.set('toJSON', {
  transform: function(doc, ret) {
    ret.availableBalance = parseFloat(ret.availableBalance.toString()).toFixed(2);
    ret.frozenBalance = parseFloat(ret.frozenBalance.toString()).toFixed(2);
    ret.pendingBalance = parseFloat(ret.pendingBalance.toString()).toFixed(2);
    ret.dailyLimit = parseFloat(ret.dailyLimit.toString()).toFixed(2);
    ret.dailySpent = parseFloat(ret.dailySpent.toString()).toFixed(2);
    delete ret.pin;
    return ret;
  }
});

module.exports = mongoose.model('Wallet', walletSchema);
