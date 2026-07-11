const User = require('../models/User');
const Device = require('../models/Device');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const crypto = require('crypto'); // Added for secure code generation
const { 
  generateAccessToken, 
  generateRefreshToken, 
  generateOTP,
  isValidEmail,
  validatePassword,
  sanitizeUser
} = require('../utils/auth');
const { sendOTPEmail, sendPasswordResetEmail } = require('../utils/email');
const config = require('../config');

/**
 * Register new user
 */
async function register(request, reply) {
  try {
    const { name, email, phoneNumber, password, referralCode } = request.body;
    
    // Validation
    if (!name || !email || !phoneNumber || !password) {
      return reply.status(400).send({
        success: false,
        message: 'All fields are required'
      });
    }
    
    if (!isValidEmail(email)) {
      return reply.status(400).send({
        success: false,
        message: 'Invalid email address'
      });
    }
    
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return reply.status(400).send({
        success: false,
        message: 'Password does not meet requirements',
        checks: passwordValidation.checks
      });
    }
    
    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { phoneNumber }]
    });
    
    if (existingUser) {
      return reply.status(409).send({
        success: false,
        message: 'User with this email or phone number already exists'
      });
    }
    
    // Check referral code (Bulletproof Version)
    let referrer = null;
    if (referralCode && referralCode.trim() !== '') {
      const cleanCode = referralCode.trim();
      
      referrer = await User.findOne({ 
        referralCode: { $regex: new RegExp(`^${cleanCode}$`, 'i') } 
      });
      
      if (!referrer) {
        return reply.status(400).send({
          success: false,
          message: 'Invalid referral code'
        });
      }
    }

    // Generate a secure, permanent 6-character referral code
    const newReferralCode = 'NP' + crypto.randomBytes(3).toString('hex').toUpperCase();
    
    // Create user
    const user = new User({
      name,
      email: email.toLowerCase(),
      phoneNumber,
      password,
      referredBy: referrer ? referrer._id : null,
      referralCode: newReferralCode // Explicitly inject the secure code
    });
    
    await user.save();
    
    // Generate OTP
    await user.generateOTP();
    
    // Create wallet
    const Wallet = require('../models/Wallet');
    const wallet = new Wallet({ user: user._id });
    await wallet.save();
    
    // Create KYC record
    const KYC = require('../models/KYC');
    const kyc = new KYC({ user: user._id });
    await kyc.save();
    
    // Log registration
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({
          user: user._id,
          action: 'register',
          description: 'User registered',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent']
        }).catch(() => {});
    }
    
    // Send OTP email via Resend
    await sendOTPEmail(user.email, user.otp);
    
    reply.status(201).send({
      success: true,
      message: 'Registration successful. Please verify your email with the OTP sent.',
      userId: user._id,
      email: user.email
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    reply.status(500).send({
      success: false,
      message: 'Registration failed'
    });
  }
}

/**
 * Verify OTP for registration
 */
async function verifyOTP(request, reply) {
  try {
    const { email, otp } = request.body;
    
    const user = await User.findByEmail(email);
    
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }
    
    if (!user.verifyOTP(otp)) {
      return reply.status(400).send({ success: false, message: 'Invalid or expired OTP' });
    }
    
    await user.consumeOTP();
    
    // THE FIX: Award real referral bonus to the inviter's wallet!
    if (user.referredBy) {
      const referrer = await User.findById(user.referredBy);
      if (referrer) {
        const bonusAmount = config.business?.defaultReferralBonus || 500;
        
        // Update user stats
        referrer.referralCount += 1;
        referrer.referralBonus = (parseFloat(referrer.referralBonus?.toString() || '0') + bonusAmount).toString();
        await referrer.save();
        
        // REAL MONEY DROP: Update Referrer's Wallet
        const Wallet = require('../models/Wallet');
        const referrerWallet = await Wallet.findOne({ user: referrer._id });

        if (referrerWallet) {
            referrerWallet.availableBalance = String(parseFloat(referrerWallet.availableBalance || '0') + bonusAmount);
            referrerWallet.balance = String(parseFloat(referrerWallet.balance || '0') + bonusAmount);
            await referrerWallet.save();

            // Create referral transaction
            const Transaction = require('../models/Transaction');
            const transaction = new Transaction({
                user: referrer._id,
                type: 'credit', 
                description: `Referral bonus for inviting ${user.name}`,
                amount: bonusAmount,
                fee: 0,
                balanceBefore: String(parseFloat(referrerWallet.availableBalance) - bonusAmount),
                balanceAfter: referrerWallet.availableBalance,
                status: 'success',
                provider: 'internal'
            });
            await transaction.save();

            // Notify the referrer instantly if they are online
            if (request.server && request.server.io) {
                request.server.io.to(`user:${referrer._id}`).emit('wallet:update', { balance: referrerWallet.availableBalance });
                request.server.io.to(`user:${referrer._id}`).emit('notification', {
                    type: 'success',
                    title: 'New Referral Bonus!',
                    message: `You earned ₦${bonusAmount} for inviting ${user.name}`
                });
            }
        }
      }
    }
    
    reply.send({
      success: true,
      message: 'Account verified successfully'
    });
    
  } catch (error) {
    console.error('OTP verification error:', error);
    reply.status(500).send({
      success: false,
      message: 'Verification failed'
    });
  }
}

/**
 * Login user
 */
async function login(request, reply) {
  try {
    const { email, password } = request.body;
    
    if (!email || !password) {
      return reply.status(400).send({
        success: false,
        message: 'Email and password are required'
      });
    }
    
    const user = await User.findByEmail(email);
    
    if (!user) {
      return reply.status(401).send({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    if (!user.isActive) {
      return reply.status(403).send({
        success: false,
        message: 'Account is inactive'
      });
    }
    
    if (user.isSuspended) {
      return reply.status(403).send({
        success: false,
        message: `Account suspended: ${user.suspensionReason || 'Contact support'}`
      });
    }
    
    if (user.isLocked) {
      return reply.status(423).send({
        success: false,
        message: 'Account locked due to too many failed attempts. Try again later.'
      });
    }
    
    const isPasswordValid = await user.comparePassword(password);
    
    if (!isPasswordValid) {
      await user.incrementLoginAttempts();
      
      return reply.status(401).send({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    // Reset login attempts
    await user.resetLoginAttempts();
    
    // Update last login
    user.lastLogin = new Date();
    user.lastLoginIP = request.ip;
    await user.save();
    
    // Track device
    const userAgent = request.headers['user-agent'] || '';
    const fingerprint = crypto.createHash('sha256').update(userAgent + request.ip).digest('hex');
    
    let device = await Device.findByFingerprint(fingerprint);
    if (!device) {
      device = new Device({
        user: user._id,
        deviceName: 'New Device',
        deviceType: detectDeviceType(userAgent),
        platform: detectPlatform(userAgent),
        browser: detectBrowser(userAgent),
        ipAddress: request.ip,
        userAgent,
        fingerprint
      });
      await device.save();
    } else {
      await device.recordLogin();
    }
    
    // Generate tokens
    const accessToken = generateAccessToken({ userId: user._id });
    const refreshToken = generateRefreshToken({ userId: user._id });
    
    // Log login
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({
          user: user._id,
          action: 'login',
          description: 'User logged in',
          ipAddress: request.ip,
          userAgent,
          deviceId: device._id
        }).catch(() => {});
    }
    
    reply.send({
      success: true,
      message: 'Login successful',
      token: accessToken,
      refreshToken,
      user: sanitizeUser(user),
      redirectUrl: '/dashboard.html'
    });
    
  } catch (error) {
    console.error('Login error:', error);
    reply.status(500).send({
      success: false,
      message: 'Login failed'
    });
  }
}

/**
 * Verify login input (for real-time validation)
 */
async function verifyLoginInput(request, reply) {
  try {
    const { email, password } = request.body;
    
    const user = await User.findByEmail(email);
    
    if (!user) {
      return reply.send({ isValidPasswordMatch: false });
    }
    
    const isPasswordValid = await user.comparePassword(password);
    
    reply.send({ isValidPasswordMatch: isPasswordValid });
    
  } catch (error) {
    reply.send({ isValidPasswordMatch: false });
  }
}

/**
 * Refresh access token
 */
async function refreshToken(request, reply) {
  try {
    const { refreshToken } = request.body;
    
    if (!refreshToken) {
      return reply.status(400).send({
        success: false,
        message: 'Refresh token is required'
      });
    }
    
    const { verifyRefreshToken } = require('../utils/auth');
    const decoded = verifyRefreshToken(refreshToken);
    
    if (!decoded) {
      return reply.status(401).send({
        success: false,
        message: 'Invalid refresh token'
      });
    }
    
    const user = await User.findById(decoded.userId);
    
    if (!user || !user.isActive) {
      return reply.status(401).send({
        success: false,
        message: 'User not found or inactive'
      });
    }
    
    const newAccessToken = generateAccessToken({ userId: user._id });
    
    reply.send({
      success: true,
      token: newAccessToken
    });
    
  } catch (error) {
    console.error('Token refresh error:', error);
    reply.status(500).send({
      success: false,
      message: 'Token refresh failed'
    });
  }
}

/**
 * Forgot password
 */
async function forgotPassword(request, reply) {
  try {
    const { email } = request.body;
    
    if (!email) {
      return reply.status(400).send({
        success: false,
        message: 'Email is required'
      });
    }
    
    const user = await User.findByEmail(email);
    
    if (!user) {
      // Don't reveal if user exists
      return reply.send({
        success: true,
        message: 'If an account exists with this email, a reset OTP has been sent.'
      });
    }
    
    await user.generateOTP();
    
    // Send password reset email via Resend
    await sendPasswordResetEmail(user.email, user.otp);
    
    reply.send({
      success: true,
      message: 'If an account exists with this email, a reset OTP has been sent.'
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    reply.status(500).send({
      success: false,
      message: 'Password reset request failed'
    });
  }
}

/**
 * Reset password with OTP
 */
async function resetPassword(request, reply) {
  try {
    const { email, otp, newPassword } = request.body;
    
    const user = await User.findByEmail(email);
    
    if (!user) {
      return reply.status(404).send({
        success: false,
        message: 'User not found'
      });
    }
    
    if (!user.verifyOTP(otp)) {
      return reply.status(400).send({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }
    
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return reply.status(400).send({
        success: false,
        message: 'Password does not meet requirements'
      });
    }
    
    user.password = newPassword;
    await user.consumeOTP();
    
    // Log password change
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({
          user: user._id,
          action: 'password_change',
          description: 'Password reset via OTP',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent']
        }).catch(() => {});
    }
    
    reply.send({
      success: true,
      message: 'Password reset successful'
    });
    
  } catch (error) {
    console.error('Password reset error:', error);
    reply.status(500).send({
      success: false,
      message: 'Password reset failed'
    });
  }
}

/**
 * Get current user profile
 */
async function getProfile(request, reply) {
  try {
    reply.send({
      success: true,
      user: sanitizeUser(request.user)
    });
  } catch (error) {
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch profile'
    });
  }
}

/**
 * Logout
 */
async function logout(request, reply) {
  try {
    // Log logout
    if (AuditLog && typeof AuditLog.logAction === 'function') {
        await AuditLog.logAction({
          user: request.user._id,
          action: 'logout',
          description: 'User logged out',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent']
        }).catch(() => {});
    }
    
    reply.send({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    reply.status(500).send({
      success: false,
      message: 'Logout failed'
    });
  }
}

// Helper functions
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
  login,
  verifyLoginInput,
  refreshToken,
  forgotPassword,
  resetPassword,
  getProfile,
  logout
};
