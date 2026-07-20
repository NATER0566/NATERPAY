const User = require('../models/User');
const Device = require('../models/Device');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const crypto = require('crypto');
const { 
  generateAccessToken, generateRefreshToken, generateOTP,
  isValidEmail, validatePassword, sanitizeUser
} = require('../utils/auth');
const { sendOTPEmail, sendPasswordResetEmail } = require('../utils/email');
const config = require('../config');

async function register(request, reply) {
  try {
    const { name, email, phoneNumber, password, referralCode } = request.body;
    
    if (!name || !email || !phoneNumber || !password) return reply.status(400).send({ success: false, message: 'All fields are required' });
    if (!isValidEmail(email)) return reply.status(400).send({ success: false, message: 'Invalid email address' });
    
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) return reply.status(400).send({ success: false, message: 'Password does not meet requirements', checks: passwordValidation.checks });
    
    const existingUser = await User.findOne({ $or: [{ email: email.toLowerCase() }, { phoneNumber }] });
    if (existingUser) return reply.status(409).send({ success: false, message: 'User with this email or phone number already exists' });
    
    let referrer = null;
    if (referralCode && referralCode.trim() !== '') {
      const cleanCode = referralCode.trim();
      referrer = await User.findOne({ referralCode: { $regex: new RegExp(`^${cleanCode}$`, 'i') } });
      if (!referrer) return reply.status(400).send({ success: false, message: 'Invalid referral code' });
    }

    const newReferralCode = 'NP' + crypto.randomBytes(3).toString('hex').toUpperCase();
    
    const user = new User({
      name, 
      email: email.toLowerCase(), 
      phoneNumber, 
      password,
      referredBy: referrer ? referrer.referralCode : null, 
      referralCode: newReferralCode,
      referralBonusPaid: false,
      isEmailVerified: false // Explicitly set to false on registration
    });
    
    await user.save();
    await user.generateOTP();
    
    const Wallet = require('../models/Wallet');
    await new Wallet({ user: user._id }).save();
    
    const KYC = require('../models/KYC');
    await new KYC({ user: user._id }).save();
    
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({ user: user._id, action: 'register', description: 'User registered', ipAddress: request.ip, userAgent: request.headers['user-agent'] }).catch(() => {});
    }
    
    await sendOTPEmail(user.email, user.otp);
    
    reply.status(201).send({ success: true, message: 'Registration successful. Please verify your email with the OTP sent.', userId: user._id, email: user.email });
  } catch (error) {
    console.error('Registration error:', error);
    reply.status(500).send({ success: false, message: 'Registration failed' });
  }
}

// LEGACY REGISTRATION OTP VERIFICATION
async function verifyOTP(request, reply) {
  try {
    const { email, otp } = request.body;
    
    const user = await User.findByEmail(email);
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
    
    if (!user.verifyOTP(otp)) return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });
    
    // THE FIX: Actually update the database so the system knows they are verified!
    user.isEmailVerified = true; 
    await user.consumeOTP();
    await user.save();
    
    reply.send({ success: true, message: 'Account verified successfully' });
    
  } catch (error) {
    console.error('OTP verification error:', error);
    reply.status(500).send({ success: false, message: 'Verification failed' });
  }
}

// ============================================================================
// NEW ENTERPRISE VERIFICATION ROUTES (TRIGGERED FROM PROFILE DASHBOARD)
// ============================================================================

async function resendVerification(request, reply) {
  try {
    const { email } = request.body;
    if (!email) return reply.status(400).send({ success: false, message: 'Email is required' });

    const user = await User.findByEmail(email);
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
    
    if (user.isEmailVerified) {
        return reply.status(400).send({ success: false, message: 'This account is already verified.' });
    }

    await user.generateOTP();
    await sendOTPEmail(user.email, user.otp);

    reply.send({ success: true, message: 'A new 6-digit OTP has been sent to your email.' });
  } catch (error) {
    console.error('Resend Verification OTP error:', error);
    reply.status(500).send({ success: false, message: 'Failed to send OTP' });
  }
}

async function verifyEmail(request, reply) {
  try {
    const { email, otp } = request.body;
    if (!email || !otp) return reply.status(400).send({ success: false, message: 'Email and OTP are required' });

    const user = await User.findByEmail(email);
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
    
    if (!user.verifyOTP(otp)) return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });

    // Update system record
    user.isEmailVerified = true;
    await user.consumeOTP();
    await user.save();

    reply.send({ success: true, message: 'Email successfully verified!' });
  } catch (error) {
    console.error('Email Verification error:', error);
    reply.status(500).send({ success: false, message: 'Failed to verify email' });
  }
}
// ============================================================================

async function login(request, reply) {
  try {
    const { email, password } = request.body;
    if (!email || !password) return reply.status(400).send({ success: false, message: 'Email and password are required' });
    
    const user = await User.findByEmail(email);
    if (!user) return reply.status(401).send({ success: false, message: 'Invalid credentials' });
    if (!user.isActive) return reply.status(403).send({ success: false, message: 'Account is inactive' });
    if (user.isSuspended) return reply.status(403).send({ success: false, message: `Account suspended: ${user.suspensionReason || 'Contact support'}` });
    if (user.isLocked) return reply.status(423).send({ success: false, message: 'Account locked due to too many failed attempts. Try again later.' });
    
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      await user.incrementLoginAttempts();
      return reply.status(401).send({ success: false, message: 'Invalid credentials' });
    }
    
    await user.resetLoginAttempts();
    user.lastLogin = new Date();
    user.lastLoginIP = request.ip;
    await user.save();
    
    const userAgent = request.headers['user-agent'] || '';
    const fingerprint = crypto.createHash('sha256').update(userAgent + request.ip).digest('hex');
    
    let device = await Device.findByFingerprint(fingerprint);
    if (!device) {
      device = new Device({ user: user._id, deviceName: 'New Device', deviceType: detectDeviceType(userAgent), platform: detectPlatform(userAgent), browser: detectBrowser(userAgent), ipAddress: request.ip, userAgent, fingerprint });
      await device.save();
    } else {
      await device.recordLogin();
    }
    
    const accessToken = generateAccessToken({ userId: user._id });
    const refreshToken = generateRefreshToken({ userId: user._id });
    
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({ user: user._id, action: 'login', description: 'User logged in', ipAddress: request.ip, userAgent, deviceId: device._id }).catch(() => {});
    }
    
    reply.send({ success: true, message: 'Login successful', token: accessToken, refreshToken, user: sanitizeUser(user), redirectUrl: '/dashboard.html' });
  } catch (error) {
    console.error('Login error:', error);
    reply.status(500).send({ success: false, message: 'Login failed' });
  }
}

async function verifyLoginInput(request, reply) {
  try {
    const { email, password } = request.body;
    const user = await User.findByEmail(email);
    if (!user) return reply.send({ isValidPasswordMatch: false });
    const isPasswordValid = await user.comparePassword(password);
    reply.send({ isValidPasswordMatch: isPasswordValid });
  } catch (error) { reply.send({ isValidPasswordMatch: false }); }
}

async function refreshToken(request, reply) {
  try {
    const { refreshToken } = request.body;
    if (!refreshToken) return reply.status(400).send({ success: false, message: 'Refresh token is required' });
    
    const { verifyRefreshToken } = require('../utils/auth');
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) return reply.status(401).send({ success: false, message: 'Invalid refresh token' });
    
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) return reply.status(401).send({ success: false, message: 'User not found or inactive' });
    
    const newAccessToken = generateAccessToken({ userId: user._id });
    reply.send({ success: true, token: newAccessToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    reply.status(500).send({ success: false, message: 'Token refresh failed' });
  }
}

async function forgotPassword(request, reply) {
  try {
    const { email } = request.body;
    if (!email) return reply.status(400).send({ success: false, message: 'Email is required' });
    
    const user = await User.findByEmail(email);
    if (!user) return reply.send({ success: true, message: 'If an account exists with this email, a reset OTP has been sent.' });
    
    await user.generateOTP();
    await sendPasswordResetEmail(user.email, user.otp);
    
    reply.send({ success: true, message: 'If an account exists with this email, a reset OTP has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    reply.status(500).send({ success: false, message: 'Password reset request failed' });
  }
}

async function resetPassword(request, reply) {
  try {
    const { email, otp, newPassword } = request.body;
    const user = await User.findByEmail(email);
    
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
    if (!user.verifyOTP(otp)) return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });
    
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) return reply.status(400).send({ success: false, message: 'Password does not meet requirements' });
    
    user.password = newPassword;
    await user.consumeOTP();
    
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({ user: user._id, action: 'password_change', description: 'Password reset via OTP', ipAddress: request.ip, userAgent: request.headers['user-agent'] }).catch(() => {});
    }
    
    reply.send({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Password reset error:', error);
    reply.status(500).send({ success: false, message: 'Password reset failed' });
  }
}

async function getProfile(request, reply) {
  try { reply.send({ success: true, user: sanitizeUser(request.user) }); } 
  catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch profile' }); }
}

async function logout(request, reply) {
  try {
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({ user: request.user._id, action: 'logout', description: 'User logged out', ipAddress: request.ip, userAgent: request.headers['user-agent'] }).catch(() => {});
    }
    reply.send({ success: true, message: 'Logout successful' });
  } catch (error) { reply.status(500).send({ success: false, message: 'Logout failed' }); }
}

async function changePassword(request, reply) {
  try {
    const { currentPassword, newPassword } = request.body;
    if (!currentPassword || !newPassword) return reply.status(400).send({ success: false, message: 'Both current and new passwords are required' });

    const user = await User.findById(request.user._id);
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return reply.status(400).send({ success: false, message: 'Incorrect current password' });

    user.password = newPassword;
    await user.save();

    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({ user: user._id, action: 'password_change', description: 'Password manually changed', ipAddress: request.ip, userAgent: request.headers['user-agent'] }).catch(() => {});
    }

    reply.send({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update password' });
  }
}

async function logoutAllSessions(request, reply) {
  try {
    const currentFingerprint = crypto.createHash('sha256').update((request.headers['user-agent'] || '') + request.ip).digest('hex');
    await Device.deleteMany({ user: request.user._id, fingerprint: { $ne: currentFingerprint } }).catch(() => {});

    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({ user: request.user._id, action: 'logout_all', description: 'Terminated all other active sessions', ipAddress: request.ip, userAgent: request.headers['user-agent'] }).catch(() => {});
    }
    reply.send({ success: true, message: 'All other sessions have been terminated' });
  } catch (error) {
    console.error('Session termination error:', error);
    reply.status(500).send({ success: false, message: 'Failed to terminate sessions' });
  }
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
  register, 
  verifyOTP, 
  resendVerification, 
  verifyEmail, 
  login, 
  verifyLoginInput, 
  refreshToken, 
  forgotPassword, 
  resetPassword, 
  getProfile, 
  logout, 
  changePassword, 
  logoutAllSessions 
};
