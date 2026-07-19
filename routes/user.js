const User = require('../models/User'); 
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const { sanitizeUser } = require('../utils/auth');
const bcrypt = require('bcryptjs'); 

/**
 * Get dashboard data (NOW SERVES LIFETIME MATH GLOBALLY TO ALL PAGES)
 */
async function getDashboardData(request, reply) {
  try {
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: user._id });
    const recentTransactions = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(15);
    const kyc = await KYC.findOne({ user: user._id });
    
    // FETCH LIFETIME SUCCESSFUL TRANSACTIONS FOR ACCURATE GLOBAL MATH
    const allTransactions = await Transaction.find({ user: user._id, status: 'success' });
    const totalLogs = allTransactions.length;
    
    let totalSpent = 0;
    let totalCommission = 0;

    allTransactions.forEach(tx => {
      const amount = parseFloat(tx.amount?.toString() || '0');
      const txType = (tx.type || '').toLowerCase();
      const desc = (tx.description || '').toLowerCase();
      
      // 1. CALCULATE TRUE OUTFLOW (SPENT)
      const isCredit = ['funding', 'referral_bonus', 'cashback', 'refund', 'task_reward'].includes(txType) || 
                       (tx.flow === 'in') || desc.includes('admin credit') ||
                       (txType === 'transfer' && (desc.includes('received') || desc.includes('from')));
                       
      if (!isCredit) {
        const feeAmt = parseFloat(tx.fee?.toString() || '0');
        const totalDed = tx.totalDeduction ? parseFloat(tx.totalDeduction.toString()) : (amount + feeAmt);
        totalSpent += totalDed;
      }

      // 2. CALCULATE TRUE LIFETIME COMMISSIONS & CASHBACK
      if (['cashback', 'task_reward', 'reward', 'referral_bonus', 'commission'].includes(txType) || 
          desc.includes('commission') || desc.includes('cashback') || desc.includes('earned') || desc.includes('bonus')) {
          totalCommission += amount;
      }
    });
    
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
      
      // GLOBAL LIFETIME VARIABLES FOR ALL HTML PAGES
      totalSpent: totalSpent.toString(),
      totalCommission: totalCommission.toString(),
      
      referralCount: user.referralCount || 0,
      referralBonus: user.referralBonus ? user.referralBonus.toString() : '0',
      cumulativeSpend: user.cumulativeSpend || 0,
      referralBonusPaid: user.referralBonusPaid || false,
      hiddenWidgets: user.hiddenWidgets || [],
      referralCode: user.referralCode,
      createdAt: user.createdAt,
      
      recentTransactions: recentTransactions.map(tx => {
        const baseAmt = parseFloat(tx.amount?.toString() || '0');
        const feeAmt = parseFloat(tx.fee?.toString() || '0');
        const totalDed = tx.totalDeduction ? parseFloat(tx.totalDeduction.toString()) : (baseAmt + feeAmt);
        const txType = (tx.type || '').toLowerCase();
        const desc = (tx.description || '').toLowerCase();
        const isCredit = ['funding', 'referral_bonus', 'cashback', 'refund', 'task_reward'].includes(txType) || 
                         (tx.flow === 'in') || desc.includes('admin credit') ||
                         (txType === 'transfer' && (desc.includes('received') || desc.includes('from')));

        return {
          _id: tx._id, date: tx.createdAt, type: tx.type, description: tx.description,
          amount: baseAmt.toString(), fee: feeAmt.toString(), totalDeduction: totalDed.toString(),
          isCredit: isCredit, status: tx.status
        };
      })
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch dashboard data' });
  }
}

async function updatePreferences(request, reply) {
  try {
    const { action, target } = request.body;
    if (action === 'hide') { if (!request.user.hiddenWidgets.includes(target)) request.user.hiddenWidgets.push(target); } 
    else if (action === 'show') { request.user.hiddenWidgets = request.user.hiddenWidgets.filter(w => w !== target); }
    await request.user.save();
    reply.send({ success: true, message: 'Preferences updated' });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to update preferences' }); }
}

async function updateProfile(request, reply) {
  try {
    const { name, phoneNumber } = request.body;
    if (name) request.user.name = name;
    if (phoneNumber) request.user.phoneNumber = phoneNumber;
    await request.user.save();
    reply.send({ success: true, message: 'Profile updated', user: sanitizeUser(request.user) });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to update profile' }); }
}

async function getReferralTree(request, reply) {
    try {
        const user = await User.findById(request.user._id);
        if (!user || !user.referralCode) return reply.send({ success: true, referrals: [] });
        const referrals = await User.find({ $or: [ { referredBy: user.referralCode }, { referredBy: { $regex: new RegExp(`^${user.referralCode}$`, 'i') } }, { referredBy: user._id.toString() } ] }).select('name createdAt email cumulativeSpend referralBonusPaid').sort({ createdAt: -1 });
        reply.send({ success: true, referrals });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch network tree' }); }
}

async function upgradeUser(request, reply) {
  try {
    const { role, amount, pin } = request.body;
    const userId = request.user._id;

    // 1. Validate Target Tier
    if (!['agent', 'reseller', 'vip'].includes(role)) {
        return reply.status(400).send({ success: false, message: 'Invalid upgrade tier selected.' });
    }

    // 2. Validate Pricing
    let expectedAmount = 2000;
    if (role === 'reseller') expectedAmount = 5000;
    if (role === 'vip') expectedAmount = 15000;

    if (amount !== expectedAmount) return reply.status(400).send({ success: false, message: 'System alert: Amount mismatch detected.' });

    // THE FIX: We must query the DB directly to get the hidden PINs.
    // Auth middleware (request.user) strips out sensitive data like passwords and PINs for security!
    const dbUser = await User.findById(userId).select('+transactionPin +withdrawalPin');
    if (!dbUser) return reply.status(404).send({ success: false, message: 'User record not found.' });

    // 3. Prevent Double Upgrades
    if (dbUser.role === 'vip' || (dbUser.role === 'reseller' && role === 'reseller')) {
        return reply.status(400).send({ success: false, message: `You are already on the ${dbUser.role.toUpperCase()} tier or higher!` });
    }

    // 4. STRICT PIN VALIDATION ENGINE
    if (!pin || pin.length !== 4) {
        return reply.status(400).send({ success: false, message: 'A valid 4-digit PIN is required.' });
    }
    
    // Grab the PIN hash from the full database record
    const userPinHash = dbUser.transactionPin || dbUser.withdrawalPin;
    
    // If the database has NO PIN for this user, completely block them
    if (!userPinHash) {
        return reply.status(400).send({ success: false, message: 'Security Alert: You have not set up a Transaction PIN yet. Please go to your Profile settings to create one.' });
    }

    // Securely compare the typed PIN against the database hash
    const isMatch = await bcrypt.compare(pin.toString(), userPinHash);
    if (!isMatch) {
        return reply.status(400).send({ success: false, message: 'Incorrect 4-Digit PIN. Upgrade aborted.' });
    }

    // 5. Wallet Check
    const wallet = await Wallet.findOne({ user: userId });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet infrastructure not found.' });

    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: `Insufficient balance. You need ₦${amount.toLocaleString()} to upgrade.` });

    // =========================================================================
    // THE FAILSAFE: Validate the transaction schema BEFORE deducting money
    // =========================================================================
    const transaction = new Transaction({ 
        user: userId, 
        type: 'withdrawal', 
        description: `Account Upgrade to ${role.toUpperCase()} Node`, 
        amount: amount, 
        fee: 0, 
        balanceBefore: currentAvail.toString(), 
        balanceAfter: (currentAvail - amount).toString(), 
        status: 'success', 
        provider: 'internal', 
        reference: `UPG-${Date.now()}` 
    });

    try {
        await transaction.validate(); 
    } catch (valError) {
        return reply.status(500).send({ success: false, message: 'Schema validation blocked the transaction. No money deducted. Error: ' + valError.message });
    }

    // 6. It is now 100% safe to deduct the upgrade fee
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    // 7. Save the pre-validated transaction
    await transaction.save();

    // 8. Update User Role
    await User.findByIdAndUpdate(userId, { role: role });

    // 9. Emit Sockets
    if (request.server && request.server.io) {
       request.server.io.to(`user:${userId}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
       request.server.io.to(`user:${userId}`).emit('notification', { type: 'success', title: 'Upgrade Successful', message: `Welcome to the ${role.toUpperCase()} tier!` });
    }
    
    const updatedUser = await User.findById(userId);
    reply.send({ success: true, message: `Upgrade to ${role.toUpperCase()} was successful!`, user: sanitizeUser(updatedUser) });

  } catch (error) { 
      console.error("UPGRADE CRASH ERROR:", error);
      reply.status(500).send({ success: false, message: 'DB Error: ' + error.message }); 
  }
}

module.exports = { getDashboardData, updatePreferences, updateProfile, getReferralTree, upgradeUser };
