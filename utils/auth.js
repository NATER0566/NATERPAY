const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Generate JWT access token
 */
function generateAccessToken(payload) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn
  });
}

/**
 * Generate JWT refresh token
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn
  });
}

/**
 * Verify JWT access token
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (error) {
    return null;
  }
}

/**
 * Verify JWT refresh token
 */
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, config.jwt.refreshSecret);
  } catch (error) {
    return null;
  }
}

/**
 * Generate OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate referral code
 */
function generateReferralCode() {
  return 'NP' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Generate API key
 */
function generateApiKey() {
  return 'np_' + require('crypto').randomBytes(32).toString('hex');
}

/**
 * Generate transaction reference
 */
function generateTransactionReference() {
  return 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
}

/**
 * Generate idempotency key
 */
function generateIdempotencyKey() {
  return 'idem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
}

/**
 * Hash data
 */
function hashData(data) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validate email
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate phone number (Nigeria)
 */
function isValidPhoneNumber(phone) {
  const phoneRegex = /^(\+234|0)[789]\d{9}$/;
  return phoneRegex.test(phone);
}

/**
 * Validate password strength
 */
function validatePassword(password) {
  const checks = {
    length: password.length >= 8 && password.length <= 16,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    special: /[\p{P}\p{S}]/u.test(password) || /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)
  };
  
  return {
    isValid: Object.values(checks).every(Boolean),
    checks
  };
}

/**
 * Sanitize user data for response
 */
function sanitizeUser(user) {
  const sanitized = user.toObject ? user.toObject() : { ...user };
  delete sanitized.password;
  delete sanitized.withdrawalPin;
  delete sanitized.otp;
  return sanitized;
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateOTP,
  generateReferralCode,
  generateApiKey,
  generateTransactionReference,
  generateIdempotencyKey,
  hashData,
  isValidEmail,
  isValidPhoneNumber,
  validatePassword,
  sanitizeUser
};
