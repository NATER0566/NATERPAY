const mongoose = require('mongoose');
const User = require('../models/User');
const Device = require('../models/Device');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const crypto = require('crypto');
const Joi = require('joi'); // [1] Strict Request Validation

const { 
  generateAccessToken, generateRefreshToken, 
  validatePassword, sanitizeUser 
} = require('../utils/auth');
const { sendOTPEmail, sendPasswordResetEmail } = require('../utils/email');

// [2] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let AuditLog, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

// [3] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [4] TEXT SANITIZATION (XSS Protection)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 255) : '';

/* =========================================================================
   [5] REDIS RATE LIMITING (CRITICAL FOR AUTH ENDPOINTS)
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 5, identifier = null) {
    const ip = request.ip;
    const id = identifier || ip; // Fallback to IP if no specific ID provided
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const key = `rate_${action}_${id}`;
        if (!fallbackRateLimits.has(key)) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(key);
        if (now > data.resetTime) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const key = `rate:${action}:${id}`;
            const count = await redisClient.incr(key);
            if (count === 1) await redisClient.expire(key, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

/* =========================================================================
   IMMUTABLE AUDIT LOGGING ENGINE
========================================================================= */
async function createAuditLog(params, session = null) {
    if (!AuditLog) return;
    try {
        const log = new AuditLog({
            user: params.user, transactionId: null, transactionReference: params.action,
            amount: 0, type: 'security', previousBalance: '0', newBalance: '0', 
            ipAddress: params.ipAddress, userAgent: params.userAgent,
            status: 'success', source: 'Auth Engine', details: { description: params.description }
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

/* ============================================================================
   REGISTRATION ENGINE (ATOMIC TRANSACTION)
============================================================================ */
async function register(request, reply) {
    try {
        if (!await checkRateLimit(request, 'register', 3)) throw { status: 429, message: 'Too many registration attempts from this IP.' };

        const schema = Joi.object({
            name: Joi.string().min(2).max(100).required(),
            email: Joi.string().email().required(),
            phoneNumber: Joi.string().required(),
            password: Joi.string().required(),
            referralCode: Joi.string().allow('', null)
        });

        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();
        
        const passwordValidation = validatePassword(value.password);
        if (!passwordValidation.isValid) return reply.status(400).send({ success: false, message: 'Password does not meet requirements', checks: passwordValidation.checks });
        
        const existingUser = await User.findOne({ $or: [{ email }, { phoneNumber: value.phoneNumber }] });
        if (existingUser) return reply.status(409).send({ success: false, message: 'User with this email or phone number already exists' });
        
        let referrer = null;
        if (value.referralCode && value.referralCode.trim() !== '') {
            const cleanCode = sanitizeText(value.referralCode);
            referrer = await User.findOne({ referralCode: { $regex: new RegExp(`^${cleanCode}$`, 'i') } });
            if (!referrer) return reply.status(400).send({ success: false, message: 'Invalid referral code' });
        }

        const newReferralCode = 'NP' + crypto.randomBytes(3).toString('hex').toUpperCase();
        
        // [6] ATOMIC DATABASE SESSION (Prevents half-created accounts)
        const session = await mongoose.startSession();
        session.startTransaction();

        let newUser;
        try {
            newUser = new User({
                name: sanitizeText(value.name), 
                email, 
                phoneNumber: sanitizeText(value.phoneNumber), 
                password: value.password,
                referredBy: referrer ? referrer.referralCode : null, 
                referralCode: newReferralCode,
                referralBonusPaid: false,
                isEmailVerified: false 
            });
            await newUser.save({ session });
            await newUser.generateOTP(); // Note: Presumes generateOTP modifies 'this' but needs saving
            await newUser.save({ session }); // Save again with OTP
            
            await new Wallet({ user: newUser._id }).save({ session });
            await new KYC({ user: newUser._id }).save({ session });
            
            await createAuditLog({ user: newUser._id, action: 'register', description: 'User registered successfully', ipAddress: request.ip, userAgent: request.headers['user-agent'] }, session);
            
            await session.commitTransaction();
            session.endSession();
        } catch (dbError) {
            await session.abortTransaction();
            session.endSession();
            throw dbError;
        }
        
        // Send email outside the transaction so network drops don't revert the database
        await sendOTPEmail(newUser.email, newUser.otp).catch(e => logger.error('Welcome OTP Email failed', e));
        
        reply.status(201).send({ success: true, message: 'Registration successful. Please verify your email with the OTP sent.', userId: newUser._id, email: newUser.email });
    } catch (error) { handleError(reply, error, 'Registration failed'); }
}

/* ============================================================================
   VERIFY OTP & AUTO-LOGIN (BRUTE-FORCE PROTECTED)
============================================================================ */
async function verifyOTP(request, reply) {
    try {
        const schema = Joi.object({ email: Joi.string().email().required(), otp: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();

        // STRICT RATE LIMIT: Prevent OTP Brute Forcing (Max 5 guesses per minute per email)
        if (!await checkRateLimit(request, 'otp_verify', 5, email)) throw { status: 429, message: 'Too many OTP attempts. Please wait.' };

        const user = await User.findOne({ email });
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        
        if (!user.verifyOTP(value.otp)) return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });
        
        user.isEmailVerified = true; 
        await user.consumeOTP();
        await user.resetLoginAttempts();
        user.lastLogin = new Date();
        user.lastLoginIP = request.ip;
        await user.save();
        
        const userAgent = request.headers['user-agent'] || '';
        const fingerprint = crypto.createHash('sha256').update(userAgent + request.ip).digest('hex');
        
        let device = await Device.findOne({ fingerprint });
        if (!device) {
            device = new Device({ user: user._id, deviceName: 'New Device', deviceType: detectDeviceType(userAgent), platform: detectPlatform(userAgent), browser: detectBrowser(userAgent), ipAddress: request.ip, userAgent, fingerprint });
            await device.save();
        } else {
            device.lastActive = new Date();
            await device.save();
        }
        
        const accessToken = generateAccessToken({ userId: user._id });
        const refreshToken = generateRefreshToken({ userId: user._id });

        await createAuditLog({ user: user._id, action: 'otp_login', description: 'User verified OTP and auto-logged in', ipAddress: request.ip, userAgent });
        
        reply.send({ success: true, message: 'Account verified and logged in', token: accessToken, refreshToken, user: sanitizeUser(user), redirectUrl: '/dashboard.html' });
    } catch (error) { handleError(reply, error, 'Verification failed'); }
}

/* ============================================================================
   ENTERPRISE VERIFICATION ROUTES (TRIGGERED FROM PROFILE DASHBOARD)
============================================================================ */
async function resendVerification(request, reply) {
    try {
        const schema = Joi.object({ email: Joi.string().email().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();
        if (!await checkRateLimit(request, 'resend_otp', 3, email)) throw { status: 429, message: 'Please wait before requesting another OTP.' };

        const user = await User.findOne({ email });
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        
        if (user.isEmailVerified) return reply.status(400).send({ success: false, message: 'This account is already verified.' });

        await user.generateOTP();
        await user.save();
        await sendOTPEmail(user.email, user.otp);

        reply.send({ success: true, message: 'A new 6-digit OTP has been sent to your email.' });
    } catch (error) { handleError(reply, error, 'Failed to send OTP'); }
}

async function verifyEmail(request, reply) {
    try {
        const schema = Joi.object({ email: Joi.string().email().required(), otp: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();
        if (!await checkRateLimit(request, 'otp_verify', 5, email)) throw { status: 429, message: 'Too many OTP attempts. Please wait.' };

        const user = await User.findOne({ email });
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        
        if (!user.verifyOTP(value.otp)) return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });

        user.isEmailVerified = true;
        await user.consumeOTP();
        await user.save();

        reply.send({ success: true, message: 'Email successfully verified!' });
    } catch (error) { handleError(reply, error, 'Failed to verify email'); }
}

/* ============================================================================
   CORE LOGIN ENGINE WITH HARD GATE INTERCEPTOR
============================================================================ */
async function login(request, reply) {
    try {
        const schema = Joi.object({ email: Joi.string().email().required(), password: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();
        
        // Prevent brute force password attacks
        if (!await checkRateLimit(request, 'login', 10, email)) throw { status: 429, message: 'Too many login attempts. Try again later.' };

        const user = await User.findOne({ email });
        if (!user) return reply.status(401).send({ success: false, message: 'Invalid credentials' });
        
        if (!user.isActive) return reply.status(403).send({ success: false, message: 'Account is inactive' });
        if (user.isSuspended) return reply.status(403).send({ success: false, message: `Account suspended: ${user.suspensionReason || 'Contact support'}` });
        if (user.isLocked) return reply.status(423).send({ success: false, message: 'Account locked due to too many failed attempts. Try again later.' });
        
        const isPasswordValid = await user.comparePassword(value.password);
        if (!isPasswordValid) {
            await user.incrementLoginAttempts();
            return reply.status(401).send({ success: false, message: 'Invalid credentials' });
        }

        // === THE HARD GATE: MANDATORY EMAIL VERIFICATION ===
        if (user.isEmailVerified === false) {
            await user.generateOTP();
            await user.save();
            await sendOTPEmail(user.email, user.otp).catch(()=>null);
            
            return reply.status(403).send({ success: false, message: 'Email verification required.', requiresVerification: true, email: user.email });
        }
        
        await user.resetLoginAttempts();
        user.lastLogin = new Date();
        user.lastLoginIP = request.ip;
        await user.save();
        
        const userAgent = request.headers['user-agent'] || '';
        const fingerprint = crypto.createHash('sha256').update(userAgent + request.ip).digest('hex');
        
        let device = await Device.findOne({ fingerprint });
        if (!device) {
            device = new Device({ user: user._id, deviceName: 'New Device', deviceType: detectDeviceType(userAgent), platform: detectPlatform(userAgent), browser: detectBrowser(userAgent), ipAddress: request.ip, userAgent, fingerprint });
            await device.save();
        } else {
            device.lastActive = new Date();
            await device.save();
        }
        
        const accessToken = generateAccessToken({ userId: user._id });
        const refreshToken = generateRefreshToken({ userId: user._id });
        
        await createAuditLog({ user: user._id, action: 'login', description: 'User logged in successfully', ipAddress: request.ip, userAgent });
        
        reply.send({ success: true, message: 'Login successful', token: accessToken, refreshToken, user: sanitizeUser(user), redirectUrl: '/dashboard.html' });
    } catch (error) { handleError(reply, error, 'Login failed'); }
}

async function verifyLoginInput(request, reply) {
    try {
        const { email, password } = request.body;
        if (!email || !password) return reply.send({ isValidPasswordMatch: false });

        // Throttle silent checks to prevent enumeration
        if (!await checkRateLimit(request, 'verify_input', 20)) return reply.send({ isValidPasswordMatch: false });

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return reply.send({ isValidPasswordMatch: false });
        
        const isPasswordValid = await user.comparePassword(password);
        reply.send({ isValidPasswordMatch: isPasswordValid });
    } catch (error) { reply.send({ isValidPasswordMatch: false }); }
}

async function refreshToken(request, reply) {
    try {
        if (!await checkRateLimit(request, 'refresh_token', 20)) throw { status: 429, message: 'Too many requests.' };

        const { refreshToken } = request.body;
        if (!refreshToken) return reply.status(400).send({ success: false, message: 'Refresh token is required' });
        
        const { verifyRefreshToken } = require('../utils/auth');
        const decoded = verifyRefreshToken(refreshToken);
        if (!decoded) return reply.status(401).send({ success: false, message: 'Invalid refresh token' });
        
        const user = await User.findById(decoded.userId);
        if (!user || !user.isActive) return reply.status(401).send({ success: false, message: 'User not found or inactive' });
        
        const newAccessToken = generateAccessToken({ userId: user._id });
        reply.send({ success: true, token: newAccessToken });
    } catch (error) { handleError(reply, error, 'Token refresh failed'); }
}

async function forgotPassword(request, reply) {
    try {
        const schema = Joi.object({ email: Joi.string().email().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();
        if (!await checkRateLimit(request, 'forgot_pw', 3, email)) throw { status: 429, message: 'Please wait before requesting again.' };

        const user = await User.findOne({ email });
        // Fail silently to prevent email enumeration
        if (!user) return reply.send({ success: true, message: 'If an account exists with this email, a reset OTP has been sent.' });
        
        await user.generateOTP();
        await user.save();
        await sendPasswordResetEmail(user.email, user.otp).catch(()=>null);
        
        reply.send({ success: true, message: 'If an account exists with this email, a reset OTP has been sent.' });
    } catch (error) { handleError(reply, error, 'Password reset request failed'); }
}

async function resetPassword(request, reply) {
    try {
        const schema = Joi.object({ email: Joi.string().email().required(), otp: Joi.string().required(), newPassword: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const email = value.email.toLowerCase();
        if (!await checkRateLimit(request, 'reset_pw', 5, email)) throw { status: 429, message: 'Too many attempts.' };

        const user = await User.findOne({ email });
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        if (!user.verifyOTP(value.otp)) return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });
        
        const passwordValidation = validatePassword(value.newPassword);
        if (!passwordValidation.isValid) return reply.status(400).send({ success: false, message: 'Password does not meet requirements' });
        
        user.password = value.newPassword;
        await user.consumeOTP();
        await user.save();
        
        await createAuditLog({ user: user._id, action: 'password_reset', description: 'Password reset via OTP successfully', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        
        reply.send({ success: true, message: 'Password reset successful' });
    } catch (error) { handleError(reply, error, 'Password reset failed'); }
}

async function getProfile(request, reply) {
    try { reply.send({ success: true, user: sanitizeUser(request.user) }); } 
    catch (error) { handleError(reply, error, 'Failed to fetch profile'); }
}

async function logout(request, reply) {
    try {
        await createAuditLog({ user: request.user._id, action: 'logout', description: 'User logged out', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Logout successful' });
    } catch (error) { handleError(reply, error, 'Logout failed'); }
}

async function changePassword(request, reply) {
    try {
        const schema = Joi.object({ currentPassword: Joi.string().required(), newPassword: Joi.string().required() });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'change_pw', 5)) throw { status: 429, message: 'Too many attempts.' };

        const user = await User.findById(request.user._id);
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });

        const isMatch = await user.comparePassword(value.currentPassword);
        if (!isMatch) return reply.status(400).send({ success: false, message: 'Incorrect current password' });

        const passwordValidation = validatePassword(value.newPassword);
        if (!passwordValidation.isValid) return reply.status(400).send({ success: false, message: 'New password does not meet security requirements' });

        user.password = value.newPassword;
        await user.save();

        await createAuditLog({ user: user._id, action: 'password_changed', description: 'Password manually changed in settings', ipAddress: request.ip, userAgent: request.headers['user-agent'] });

        reply.send({ success: true, message: 'Password updated successfully' });
    } catch (error) { handleError(reply, error, 'Failed to update password'); }
}

async function logoutAllSessions(request, reply) {
    try {
        const currentFingerprint = crypto.createHash('sha256').update((request.headers['user-agent'] || '') + request.ip).digest('hex');
        await Device.deleteMany({ user: request.user._id, fingerprint: { $ne: currentFingerprint } }).catch(() => {});

        await createAuditLog({ user: request.user._id, action: 'logout_all', description: 'Terminated all other active sessions', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'All other sessions have been terminated' });
    } catch (error) { handleError(reply, error, 'Failed to terminate sessions'); }
}

function detectDeviceType(userAgent) {
    if (/mobile/i.test(userAgent)) return 'mobile';
    if (/tablet/i.test(userAgent)) return 'tablet';
    if (/desktop/i.test(userAgent)) return 'desktop';
    return 'other';
}

function detectPlatform(userAgent) {
    if (/windows/i.test(userAgent)) return 'Windows';
    if (/mac/i.test(userAgent)) return 'MacOS';
    if (/linux/i.test(userAgent)) return 'Linux';
    if (/android/i.test(userAgent)) return 'Android';
    if (/ios/i.test(userAgent)) return 'iOS';
    return 'Unknown';
}

function detectBrowser(userAgent) {
    if (/chrome/i.test(userAgent)) return 'Chrome';
    if (/firefox/i.test(userAgent)) return 'Firefox';
    if (/safari/i.test(userAgent)) return 'Safari';
    if (/edge/i.test(userAgent)) return 'Edge';
    return 'Unknown';
}

module.exports = { 
    register, verifyOTP, resendVerification, verifyEmail, login, 
    verifyLoginInput, refreshToken, forgotPassword, resetPassword, 
    getProfile, logout, changePassword, logoutAllSessions 
};
