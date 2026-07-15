const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

// ============================================================================
// REAL PROFILE COMPLETION REWARD ENGINE
// ============================================================================
async function claimProfileReward(request, reply) {
    const userId = request.user._id;
    const idempotencyKey = `profile_reward_${userId}`; // Ensures they can only claim this ONCE in their lifetime

    try {
        // 1. Check if already claimed
        const existingClaim = await Transaction.findOne({ idempotencyKey });
        if (existingClaim) {
            return reply.status(400).send({ success: false, message: 'You have already claimed your profile completion reward.' });
        }

        // 2. Fetch User and verify they actually completed their profile
        const User = mongoose.models.User || mongoose.model('User');
        const user = await User.findById(userId);

        // Security check: Don't pay if email isn't verified (Adjust this based on your exact KYC logic)
        if (!user || !user.isEmailVerified) {
            return reply.status(400).send({ success: false, message: 'Please verify your email address to unlock this reward.' });
        }

        // 3. Credit the Wallet (₦50 Reward)
        const wallet = await Wallet.findOne({ user: userId });
        if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found.' });

        const currentAvail = parseFloat(wallet.availableBalance || 0);
        wallet.availableBalance = String(currentAvail + 50);
        wallet.balance = String(parseFloat(wallet.balance || 0) + 50);
        await wallet.save();

        // 4. Generate Ledger Receipt
        const tx = new Transaction({
            user: userId,
            type: 'task_reward', 
            description: 'Profile KYC Completion Reward',
            amount: 50,
            fee: 0,
            balanceBefore: String(currentAvail),
            balanceAfter: wallet.availableBalance,
            status: 'success',
            provider: 'system',
            idempotencyKey 
        });
        await tx.save();

        return reply.send({ success: true, message: '₦50 Profile Reward credited successfully!' });

    } catch (error) {
        console.error('[PROFILE REWARD ERROR]:', error);
        return reply.status(500).send({ success: false, message: 'Internal server error processing reward.' });
    }
}

// ============================================================================
// DYNAMIC CLICK & EARN AD ENGINE
// ============================================================================
async function claimAd(request, reply) {
    const { adId } = request.body;
    const userId = request.user._id;

    const todayStr = new Date().toISOString().split('T')[0];
    const dailySecurityKey = `task_ad_${adId}_${userId}_${todayStr}`;

    try {
        // 1. Double-Spend Protection (Once per day per ad)
        const existingClaim = await Transaction.findOne({ idempotencyKey: dailySecurityKey });
        if (existingClaim) {
            return reply.status(400).send({ success: false, message: 'You have already claimed this ad reward today. Check back tomorrow!' });
        }

        // 2. FETCH REAL AD FROM DATABASE
        const AdModel = mongoose.models.Ad;
        let rewardAmount = 5; // Default fallback
        let adName = `Sponsored Campaign #${adId}`;

        if (AdModel) {
            const adData = await AdModel.findById(adId);
            if (!adData) return reply.status(404).send({ success: false, message: 'Ad campaign has expired or does not exist.' });
            
            rewardAmount = parseFloat(adData.rewardAmount || 5);
            adName = `Ad Reward: ${adData.title || 'Sponsored Link'}`;
            
            // Deduct from Advertiser's Budget here if needed in the future
        }

        // 3. Credit User Wallet
        const wallet = await Wallet.findOne({ user: userId });
        const currentAvail = parseFloat(wallet.availableBalance || 0);
        wallet.availableBalance = String(currentAvail + rewardAmount);
        wallet.balance = String(parseFloat(wallet.balance || 0) + rewardAmount);
        await wallet.save();

        // 4. Generate Ledger Receipt
        const tx = new Transaction({
            user: userId,
            type: 'task_reward', 
            description: adName,
            amount: rewardAmount,
            fee: 0,
            balanceBefore: String(currentAvail),
            balanceAfter: wallet.availableBalance,
            status: 'success',
            provider: 'system',
            metadata: { adId },
            idempotencyKey: dailySecurityKey 
        });
        await tx.save();

        return reply.send({ success: true, message: `₦${rewardAmount} credited successfully.` });
        
    } catch (error) {
        console.error('[TASK ENGINE ERROR]:', error);
        if (error.code === 11000) return reply.status(400).send({ success: false, message: 'Reward already claimed today.' });
        return reply.status(500).send({ success: false, message: 'Internal server error processing reward.' });
    }
}

module.exports = {
    claimAd,
    claimProfileReward
};
