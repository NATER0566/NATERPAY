const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

// ============================================================================
// REAL PROFILE COMPLETION REWARD ENGINE (KYC FOCUSED)
// ============================================================================
async function claimProfileReward(request, reply) {
    const userId = request.user._id;
    const idempotencyKey = `profile_reward_${userId}`; 

    try {
        const existingClaim = await Transaction.findOne({ idempotencyKey });
        if (existingClaim) {
            return reply.status(400).send({ success: false, message: 'You have already claimed your profile completion reward.' });
        }

        const User = mongoose.models.User || mongoose.model('User');
        const user = await User.findById(userId);

        // STRICT KYC CHECK: Ensures they actually completed KYC
        const isKycApproved = user && (user.kycStatus === 'approved' || user.kycLevel >= 1 || user.kycTier >= 1);
        
        if (!isKycApproved) {
            return reply.status(400).send({ 
                success: false, 
                message: 'Please complete your KYC Identity Verification to unlock this reward.' 
            });
        }

        const wallet = await Wallet.findOne({ user: userId });
        if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found.' });

        const currentAvail = parseFloat(wallet.availableBalance || 0);
        wallet.availableBalance = String(currentAvail + 50);
        wallet.balance = String(parseFloat(wallet.balance || 0) + 50);
        await wallet.save();

        const tx = new Transaction({
            user: userId,
            type: 'task_reward', 
            description: 'KYC Verification Reward',
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
        const existingClaim = await Transaction.findOne({ idempotencyKey: dailySecurityKey });
        if (existingClaim) {
            return reply.status(400).send({ success: false, message: 'You have already claimed this ad reward today. Check back tomorrow!' });
        }

        const AdModel = mongoose.models.Ad;
        let rewardAmount = 5; 
        let adName = `Sponsored Campaign #${adId}`;

        if (AdModel) {
            const adData = await AdModel.findById(adId);
            if (!adData) return reply.status(404).send({ success: false, message: 'Ad campaign has expired or does not exist.' });
            
            rewardAmount = parseFloat(adData.rewardAmount || 5);
            adName = `Ad Reward: ${adData.title || 'Sponsored Link'}`;
        }

        const wallet = await Wallet.findOne({ user: userId });
        const currentAvail = parseFloat(wallet.availableBalance || 0);
        wallet.availableBalance = String(currentAvail + rewardAmount);
        wallet.balance = String(parseFloat(wallet.balance || 0) + rewardAmount);
        await wallet.save();

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
