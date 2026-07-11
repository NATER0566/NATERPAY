const User = require('../models/User'); // Fixed capital 'C' typo here
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const { sanitizeUser } = require('../utils/auth');
const bcrypt = require('bcryptjs'); // Added for secure PIN verification

/**
 * Get dashboard data
 */
async function getDashboardData(request, reply) {
  try {
    const user = request.user;
    
    // Get wallet
    const wallet = await Wallet.findByUser(user._id);
    
    // Get recent transactions
    const recentTransactions = await Transaction.findByUser(user._id, { limit: 10 });
    
    // Get KYC status
    const kyc = await KYC.findByUser(user._id);
    
    // Calculate stats
    const allTransactions = await Transaction.findByUser(user._id, { limit: 1000 });
    const totalLogs = allTransactions.length;
    const totalSpent = allTransactions.reduce((sum, tx) => {
      if (['airtime', 'data', 'electricity', 'cable', 'betting', 'bulk_sms', 'insurance', 'pos'].includes(tx.type)) {
        return sum + parseFloat(tx.amount.toString());
      }
      return sum;
    }, 0);
    
    reply.send({
      success: true,
      userFullName: user.name,
      userEmail: user.email,
      userPhone: user.phoneNumber,
      userRole: user.role,
      kycLevel: kyc ? kyc.currentLevel : 0,
      isSecured: user.isSecured,
      balance: wallet ? wallet.availableBalance.toString() : '0',
      totalLogs,
      totalSpent,
      referralCount: user.referralCount,
      referralBonus: user.referralBonus.toString(),
      hiddenWidgets: user.hiddenWidgets || [],
      recentTransactions: recentTransactions.map(tx => ({
        _id: tx._id,
        date: tx.createdAt,
        type: tx.type,
        description: tx.description,
        amount: tx.amount.toString(),
        status: tx.status
      }))
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
}

/**
 * Update dashboard preferences
 */
async function updatePreferences(request, reply) {
  try {
    const { action, target } = request.body;
    
    if (action === 'hide') {
      if (!request.user.hiddenWidgets.includes(target)) {
        request.user.hiddenWidgets.push(target);
      }
    } else if (action === 'show') {
      request.user.hiddenWidgets = request.user.hiddenWidgets.filter(w => w !== target);
    }
    
    await request.user.save();
    
    reply.send({
      success: true,
      message: 'Preferences updated'
    });
  } catch (error) {
    console.error('Preferences update error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update preferences'
    });
  }
}

/**
 * Update user profile
 */
async function updateProfile(request, reply) {
  try {
    const { name, phoneNumber } = request.body;
    
    if (name) request.user.name = name;
    if (phoneNumber) request.user.phoneNumber = phoneNumber;
    
    await request.user.save();
    
    reply.send({
      success: true,
      message: 'Profile updated',
      user: sanitizeUser(request.user)
    });
  } catch (error) {
    console.error('Profile update error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update profile'
    });
  }
}

/**
 * Get referral tree
 */
async function getReferralTree(request, reply) {
  try {
    const referrals = await User.getReferralTree(request.user._id);
    
    reply.send({
      success: true,
      referrals: referrals.map(r => ({
        id: r._id,
        name: r.name,
        email: r.email,
        phoneNumber: r.phoneNumber,
        referralCount: r.referralCount,
        joinedAt: r.createdAt
      }))
    });
  } catch (error) {
    console.error('Referral tree error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch referral tree'
    });
  }
}

/**
 * NATER-PAY PREMIUM UPGRADE ENGINE
 */
async function upgradeUser(request, reply) {
  try {
    const { role, amount, pin } = request.body;
    const user = request.user;

    // 1. Validate Input & Tiers
    if (!['agent', 'reseller'].includes(role)) {
      return reply.status(400).send({ success: false, message: 'Invalid upgrade tier selected.' });
    }
    
    const expectedAmount = role === 'reseller' ? 5000 : 2000;
    if (amount !== expectedAmount) {
      return reply.status(400).send({ success: false, message: 'System alert: Amount mismatch detected.' });
    }

    // 2. Prevent Double Upgrades
    if (user.role === 'reseller' || (user.role === 'agent' && role === 'agent')) {
      return reply.status(400).send({ success: false, message: `You are already on the ${user.role.toUpperCase()} tier or higher!` });
    }

    // 3. Verify Transaction PIN Securely
    if (!pin || pin.length !== 4) {
      return reply.status(400).send({ success: false, message: 'A valid 4-digit PIN is required.' });
    }
    
    if (user.transactionPin) {
      const isMatch = await bcrypt.compare(pin.toString(), user.transactionPin);
      if (!isMatch) {
        return reply.status(400).send({ success: false, message: 'Incorrect Withdrawal PIN.' });
      }
    }

    // 4. Wallet Checks & Deduction
    const wallet = await Wallet.findOne({ user: user._id });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet infrastructure not found.' });

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) {
      return reply.status(400).send({ success: false, message: `Insufficient balance. You need ₦${amount.toLocaleString()} to upgrade.` });
    }

    // Deduct Funds safely
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    // 5. Log Transaction in Audit Ledger
    const transaction = new Transaction({
      user: user._id,
      type: 'reseller_upgrade',
      description: `Account Upgrade to ${role.toUpperCase()} Node`,
      amount: amount,
      fee: 0,
      balanceBefore: currentAvail.toString(),
      balanceAfter: wallet.availableBalance.toString(),
      status: 'success',
      provider: 'internal',
      reference: `UPG-${Date.now()}`
    });
    await transaction.save();

    // 6. Update User Role
    user.role = role;
    await user.save();

    // 7. Fire Real-time Socket Update to Dashboard
    if (request.server && request.server.io) {
       request.server.io.to(`user:${user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
       request.server.io.to(`user:${user._id}`).emit('notification', { 
           type: 'success', 
           title: 'Upgrade Successful', 
           message: `Welcome to the ${role.toUpperCase()} tier!` 
       });
    }

    reply.send({
      success: true,
      message: `Upgrade to ${role.toUpperCase()} was incredibly successful!`,
      user: sanitizeUser(user)
    });

  } catch (error) {
    console.error('Upgrade Engine Error:', error);
    reply.status(500).send({ success: false, message: 'System network error during upgrade.' });
  }
}

module.exports = {
  getDashboardData,
  updatePreferences,
  updateProfile,
  getReferralTree,
  upgradeUser
};
