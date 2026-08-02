const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const walletSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  // Ensure default is 0 so it is never 'undefined'
  balance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  availableBalance: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  pin: {
    type: String,
    default: null
  },
  isFrozen: {
    type: Boolean,
    default: false
  },
  currency: {
    type: String,
    default: 'NGN'
  },
  // [NEW] Secure storage for Korapay permanent virtual account
  virtualAccount: {
    bankName: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null },
    accountReference: { type: String, default: null }
  }
}, {
  timestamps: true
});

// Create a virtual property that tells us if the user has a PIN
walletSchema.virtual('pinSet').get(function() {
  return !!this.pin;
});

// Securely hash the PIN before saving
walletSchema.methods.setPin = async function(rawPin) {
  const salt = await bcrypt.genSalt(10);
  this.pin = await bcrypt.hash(String(rawPin), salt);
  return this.save();
};

// Securely verify the PIN
walletSchema.methods.verifyPin = async function(rawPin) {
  if (!this.pin) return false;
  return await bcrypt.compare(String(rawPin), this.pin);
};

// Static helper to quickly find a wallet
walletSchema.statics.findByUser = function(userId) {
  return this.findOne({ user: userId });
};

// Convert Decimal128 to clean readable strings for the frontend safely
walletSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.balance = ret.balance ? parseFloat(String(ret.balance)).toFixed(2) : '0.00';
    ret.availableBalance = ret.availableBalance ? parseFloat(String(ret.availableBalance)).toFixed(2) : '0.00';
    delete ret.pin; // Never send the hashed PIN to the frontend
    return ret;
  }
});

module.exports = mongoose.model('Wallet', walletSchema);
