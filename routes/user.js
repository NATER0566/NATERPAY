const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const { sanitizeUser } = require('../utils/auth');

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
      if (['airtime', 'data', 'electricity', 'cable', 'betting', 'bulk_sms'].includes(tx.type)) {
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

module.exports = {
  getDashboardData,
  updatePreferences,
  updateProfile,
  getReferralTree
};
