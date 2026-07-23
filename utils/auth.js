const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

// ============================================================================
// JSON WEB TOKEN (JWT) ENGINE
// ============================================================================

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

// ============================================================================
// CRYPTOGRAPHICALLY SECURE GENERATORS (Replaced Math.random)
// ============================================================================

/**
 * Generate a Cryptographically Secure 6-Digit OTP
 */
function generateOTP() {
    // crypto.randomInt ensures true cryptographic randomness, unbreakable by PRNG prediction
    return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Generate a Secure Referral Code
 */
function generateReferralCode() {
    // Generates a random 6-character hex string (e.g., NP-A1B2C3)
    return 'NP' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Generate a 256-bit API Key
 */
function generateApiKey() {
    return 'np_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Generate Zero-Collision Transaction Reference using UUIDv4
 */
function generateTransactionReference() {
    // UUIDv4 guarantees absolute uniqueness even across distributed microservices
    return 'tx_' + crypto.randomUUID().replace(/-/g, '');
}

/**
 * Generate Zero-Collision Idempotency Key
 */
function generateIdempotencyKey() {
    return 'idem_' + crypto.randomUUID().replace(/-/g, '');
}

/**
 * Secure Data Fingerprinting (SHA-256)
 */
function hashData(data) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
}

// ============================================================================
// STRICT VALIDATION ENGINE
// ============================================================================

/**
 * Validate email structurally
 */
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
}

/**
 * Validate phone number (Strict Nigeria formatting)
 */
function isValidPhoneNumber(phone) {
    if (!phone || typeof phone !== 'string') return false;
    // Strip all spaces and dashes before checking
    const cleanPhone = phone.replace(/[\s-]/g, '');
    const phoneRegex = /^(\+234|0)[789]\d{9}$/;
    return phoneRegex.test(cleanPhone);
}

/**
 * Validate Enterprise Password Strength
 */
function validatePassword(password) {
    if (!password || typeof password !== 'string') return { isValid: false, checks: {} };

    const checks = {
        length: password.length >= 8 && password.length <= 64, // Added max length to prevent ReDoS
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

// ============================================================================
// DATA SANITIZATION ENGINE (Data Leak Prevention)
// ============================================================================

/**
 * Aggressively strip ALL security metadata before sending to the frontend
 */
function sanitizeUser(user) {
    if (!user) return null;
    
    // Safely convert Mongoose document to plain object
    const sanitized = user.toObject ? user.toObject({ virtuals: true }) : JSON.parse(JSON.stringify(user));
    
    // Purge ALL critical security fields
    delete sanitized.password;
    delete sanitized.transactionPin;
    delete sanitized.withdrawalPin;
    delete sanitized.pin; // For wallet populations
    delete sanitized.otp;
    delete sanitized.otpExpiry;
    delete sanitized.failedLoginAttempts;
    delete sanitized.failedPinAttempts;
    delete sanitized.pinLockUntil;
    delete sanitized.isLocked;
    delete sanitized.__v; // Remove Mongoose versioning
    
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
