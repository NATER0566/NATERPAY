const User = require('../models/User'); 
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const { sanitizeUser } = require('../utils/auth');
const bcrypt = require('bcryptjs'); 

/**
 * Get dashboard data
 */
async function getDashboardData(request, reply) {
  try {
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findByUser(user._id);
    const recentTransactions = await Transaction.findByUser(user._id, { limit: 10 });
    const kyc = await KYC.findByUser(user._id);
    
    const allTransactions = await Transaction.findByUser(user._id, { limit: 1000 });
    const totalLogs = allTransactions.length;
    
    // === CRITICAL FIX: TRUE OUTFLOW CALCULATOR ===
    // This now counts ALL successful debits (VTU, Ads, Upgrades, Withdrawals, Transfers out)
    const totalSpent = allTransactions.reduce((sum, tx) => {
      if (tx.status !== 'success') return sum; 
      
      const txType = (tx.type || '').toLowerCase();
      const desc = (tx.description || '').toLowerCase();
      
      const isCredit = ['funding', 'referral_bonus', 'cashback', 'refund', 'task_reward'].includes(txType) || 
                       (tx.flow === 'in') || 
                       desc.includes('admin credit') ||
                       (txType === 'transfer' && (desc.includes('received') || desc.includes('from')));
                       
      if (!isCredit) {
        const baseAmt = parseFloat(tx.amount?.toString() || '0');
        const feeAmt = parseFloat(tx.fee?.toString() || '0');
        const totalDed = tx.totalDeduction ? parseFloat(tx.totalDeduction.toString()) : (baseAmt + feeAmt);
        return sum + totalDed;
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
      referralCount: user.referralCount || 0,
      referralBonus: user.referralBonus ? user.referralBonus.toString() : '0',
      
      cumulativeSpend: user.cumulativeSpend || 0,
      referralBonusPaid: user.referralBonusPaid || false,
      hiddenWidgets: user.hiddenWidgets || [],
      referralCode: user.referralCode,
      createdAt: user.createdAt,
      
      // === CRITICAL DASHBOARD FIX: SEND FULL FEE MATH TO UI ===
      recentTransactions: recentTransactions.map(tx => {
        const baseAmt = parseFloat(tx.amount?.toString() || '0');
        const feeAmt = parseFloat(tx.fee?.toString() || '0');
        const totalDed = tx.totalDeduction ? parseFloat(tx.totalDeduction.toString()) : (baseAmt + feeAmt);
        
        const txType = (tx.type || '').toLowerCase();
        const desc = (tx.description || '').toLowerCase();
        const isCredit = ['funding', 'referral_bonus', 'cashback', 'refund', 'task_reward'].includes(txType) || 
                         (tx.flow === 'in') || 
                         desc.includes('admin credit') ||
                         (txType === 'transfer' && (desc.includes('received') || desc.includes('from')));

        return {
          _id: tx._id,
          date: tx.createdAt,
          type: tx.type,
          description: tx.description,
          amount: baseAmt.toString(),
          fee: feeAmt.toString(),
          totalDeduction: totalDed.toString(),
          isCredit: isCredit,
          status: tx.status
        };
      })
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch dashboard data' });
  }
}

/**
 * Update dashboard preferences
 */
async function updatePreferences(request, reply) {
  try {
    const { action, target } = request.body;
    if (action === 'hide') {
      if (!request.user.hiddenWidgets.includes(target)) request.user.hiddenWidgets.push(target);
    } else if (action === 'show') {
      request.user.hiddenWidgets = request.user.hiddenWidgets.filter(w => w !== target);
    }
    await request.user.save();
    reply.send({ success: true, message: 'Preferences updated' });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to update preferences' });
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
    reply.send({ success: true, message: 'Profile updated', user: sanitizeUser(request.user) });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to update profile' });
  }
}

/**
 * Get referral tree
 */
async function getReferralTree(request, reply) {
    try {
        const user = await User.findById(request.user._id);
        if (!user || !user.referralCode) {
            return reply.send({ success: true, referrals: [] });
        }

        const referrals = await User.find({ 
            $or: [
                { referredBy: user.referralCode },
                { referredBy: { $regex: new RegExp(`^${user.referralCode}$`, 'i') } },
                { referredBy: user._id.toString() }
            ]
        })
        .select('name createdAt email cumulativeSpend referralBonusPaid')
        .sort({ createdAt: -1 });

        reply.send({ success: true, referrals });
    } catch (error) {
        console.error("Referral Tree Error:", error);
        reply.status(500).send({ success: false, message: 'Failed to fetch network tree' });
    }
}

/**
 * NATER-PAY PREMIUM UPGRADE ENGINE
 */
async function upgradeUser(request, reply) {
  try {
    const { role, amount, pin } = request.body;
    const user = request.user;

    if (!['agent', 'reseller'].includes(role)) return reply.status(400).send({ success: false, message: 'Invalid upgrade tier selected.' });
    
    const expectedAmount = role === 'reseller' ? 5000 : 2000;
    if (amount !== expectedAmount) return reply.status(400).send({ success: false, message: 'System alert: Amount mismatch detected.' });

    if (user.role === 'reseller' || (user.role === 'agent' && role === 'agent')) {
      return reply.status(400).send({ success: false, message: `You are already on the ${user.role.toUpperCase()} tier or higher!` });
    }

    if (!pin || pin.length !== 4) return reply.status(400).send({ success: false, message: 'A valid 4-digit PIN is required.' });
    
    if (user.transactionPin) {
      const isMatch = await bcrypt.compare(pin.toString(), user.transactionPin);
      if (!isMatch) return reply.status(400).send({ success: false, message: 'Incorrect Withdrawal PIN.' });
    } else if (user.withdrawalPin) {
      const isMatch = await bcrypt.compare(pin.toString(), user.withdrawalPin);
      if (!isMatch) return reply.status(400).send({ success: false, message: 'Incorrect Withdrawal PIN.' });
    }

    const wallet = await Wallet.findOne({ user: user._id });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet infrastructure not found.' });

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) {
      return reply.status(400).send({ success: false, message: `Insufficient balance. You need ₦${amount.toLocaleString()} to upgrade.` });
    }

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: user._id, type: 'reseller_upgrade', description: `Account Upgrade to ${role.toUpperCase()} Node`,
      amount: amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'success', provider: 'internal', reference: `UPG-${Date.now()}`
    });
    await transaction.save();

    user.role = role;
    await user.save();

    if (request.server && request.server.io) {
       request.server.io.to(`user:${user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
       request.server.io.to(`user:${user._id}`).emit('notification', { type: 'success', title: 'Upgrade Successful', message: `Welcome to the ${role.toUpperCase()} tier!` });
    }

    reply.send({ success: true, message: `Upgrade to ${role.toUpperCase()} was incredibly successful!`, user: sanitizeUser(user) });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'System network error during upgrade.' });
  }
}

module.exports = { getDashboardData, updatePreferences, updateProfile, getReferralTree, upgradeUser };
