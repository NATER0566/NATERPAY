const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

// ============================================================================
// PROFILE COMPLETION REWARD ENGINE (STRICT KYC LEVEL 3 REQUIRED)
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

        // STRICT ENTERPRISE RULE: Backend now mathematically forces KYC Level 3
        const isKycApproved = user && (user.kycLevel >= 3);
        if (!isKycApproved) {
            return reply.status(400).send({ success: false, message: 'Please complete all 3 levels of KYC Identity & Address Verification to unlock this reward.' });
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
// STRICT ONCE-IN-A-LIFETIME CLICK & EARN AD ENGINE (WITH ACTIVE VIEW COUNTING)
// ============================================================================
async function claimAd(request, reply) {
    const { adId } = request.body;
    const userId = request.user._id;

    // 1. LIFETIME SECURITY KEY (No date attached. Once per user, forever.)
    const lifetimeSecurityKey = `task_ad_${adId}_${userId}`;

    try {
        // 2. LIFETIME DOUBLE-SPEND PROTECTION
        const existingClaim = await Transaction.findOne({ idempotencyKey: lifetimeSecurityKey });
        if (existingClaim) {
            return reply.status(400).send({ 
                success: false, 
                message: 'already claimed' // Triggers the UI to hide the ad permanently
            });
        }

        // 3. DAILY LIMIT ENFORCEMENT (Max 20 ads per day)
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        const dailyClaimsCount = await Transaction.countDocuments({
            user: userId,
            type: 'task_reward',
            createdAt: { $gte: todayStart },
            description: { $regex: /^Ad Reward:/ } 
        });

        if (dailyClaimsCount >= 20) {
            return reply.status(400).send({ 
                success: false, 
                message: 'Daily limit reached! You have completed your 20 rewarded ads for today. Check back tomorrow.' 
            });
        }

        // 4. FETCH REAL AD & DYNAMICALLY UPDATE VIEWS
        const AdModel = mongoose.models.Ad;
        let rewardAmount = 5; 
        let adName = `Sponsored Campaign #${adId}`;

        if (AdModel) {
            // THE FIX: Atomically increment IMPRESSIONS and decrement remaining views in one action
            const adData = await AdModel.findOneAndUpdate(
                { _id: adId, remainingViews: { $gt: 0 } },
                { $inc: { impressions: 1, remainingViews: -1 } },
                { new: true } // Returns the updated document
            );

            // If it returns null, it means remainingViews hit 0, or it was deleted
            if (!adData) {
                const exists = await AdModel.findById(adId);
                if (!exists) return reply.status(404).send({ success: false, message: 'Ad campaign has expired or does not exist.' });
                return reply.status(400).send({ success: false, message: 'limit reached' }); // Tell frontend to hide it
            }

            rewardAmount = parseFloat(adData.rewardAmount || 5);
            adName = `Ad Reward: ${adData.title || 'Sponsored Link'}`;
        }

        // 5. CREDIT USER WALLET
        const wallet = await Wallet.findOne({ user: userId });
        const currentAvail = parseFloat(wallet.availableBalance || 0);
        wallet.availableBalance = String(currentAvail + rewardAmount);
        wallet.balance = String(parseFloat(wallet.balance || 0) + rewardAmount);
        await wallet.save();

        // 6. GENERATE AUDITABLE LEDGER RECEIPT
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
            idempotencyKey: lifetimeSecurityKey 
        });
        await tx.save();

        return reply.send({ success: true, message: `₦${rewardAmount} credited successfully.` });
        
    } catch (error) {
        console.error('[TASK ENGINE ERROR]:', error);
        if (error.code === 11000) return reply.status(400).send({ success: false, message: 'already claimed' });
        return reply.status(500).send({ success: false, message: 'Internal server error processing reward.' });
    }
}

module.exports = { claimAd, claimProfileReward };
