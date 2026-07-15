const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

async function claimAd(request, reply) {
    const { adId } = request.body;
    const userId = request.user._id;

    let rewardAmount = 0;
    let adName = '';
    
    if (adId === 1) {
        rewardAmount = 5; 
        adName = 'Sponsored Ad: Nater Learning Hub';
    } else if (adId === 2) {
        rewardAmount = 4; 
        adName = 'Sponsored Ad: Nater Grace Code';
    } else {
        return reply.status(400).send({ success: false, message: 'Invalid Ad ID' });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const dailySecurityKey = `task_ad_${adId}_${userId}_${todayStr}`;

    try {
        const existingClaim = await Transaction.findOne({ idempotencyKey: dailySecurityKey });
        if (existingClaim) {
            return reply.status(400).send({ 
                success: false, 
                message: 'You have already claimed this ad reward today. Check back tomorrow!' 
            });
        }

        const wallet = await Wallet.findOne({ user: userId });
        if (!wallet) {
            return reply.status(404).send({ success: false, message: 'Wallet ledger not found.' });
        }

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

        return reply.send({ success: true, message: 'Reward credited successfully.' });
        
    } catch (error) {
        console.error('[TASK ENGINE ERROR]:', error);
        if (error.code === 11000) {
            return reply.status(400).send({ success: false, message: 'Reward already claimed today.' });
        }
        return reply.status(500).send({ success: false, message: 'Internal server error processing reward.' });
    }
}

module.exports = {
    claimAd
};
