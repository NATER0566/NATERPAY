const User = require('../models/User');
const Transaction = require('../models/Transaction');

async function getLeaderboard(request, reply) {
    try {
        // 1. GET TOP REFERRERS
        // Scans the User database for people with the highest referral counts
        const topReferrersData = await User.find({ referralCount: { $gt: 0 } })
            .sort({ referralCount: -1 })
            .limit(10)
            .select('name referralCount');

        const referrersList = topReferrersData.map(u => ({
            name: u.name || 'Naterpay User',
            refs: u.referralCount,
            points: u.referralCount * 50 // 50 Points per referral
        }));

        // 2. GET TOP TRANSACTORS
        // Uses MongoDB Aggregation to securely group successful transactions by user
        const topTransactorsData = await Transaction.aggregate([
            { $match: { status: 'success' } },
            { $group: { _id: '$user', txs: { $sum: 1 } } },
            { $sort: { txs: -1 } },
            { $limit: 10 },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
            { $unwind: '$userInfo' }
        ]);

        const transactorsList = topTransactorsData.map(t => ({
            name: t.userInfo.name || 'Naterpay User',
            txs: t.txs,
            points: t.txs * 10 // 10 Points per transaction
        }));

        // 3. RETURN SECURE PAYLOAD
        return reply.send({
            success: true,
            referrers: referrersList,
            transactors: transactorsList
        });

    } catch (error) {
        console.error('[LEADERBOARD ERROR]:', error);
        return reply.status(500).send({ success: false, message: 'Failed to synchronize global ledger.' });
    }
}

module.exports = {
    getLeaderboard
};
