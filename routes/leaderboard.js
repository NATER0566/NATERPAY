const User = require('../models/User');
const Transaction = require('../models/Transaction');

async function getLeaderboard(request, reply) {
    try {
        // 1. TOP REFERRERS
        const topReferrersData = await User.find({ referralCount: { $gt: 0 } })
            .sort({ referralCount: -1 }).limit(10).select('name referralCount');
        const referrers = topReferrersData.map(u => ({
            name: u.name || 'Naterpay User', count: u.referralCount, points: u.referralCount * 50
        }));

        // HELPER FUNCTION: Securely aggregate transactions by type
        async function getTopUsersByTxType(typesArray, pointsMultiplier) {
            const data = await Transaction.aggregate([
                { $match: { status: 'success', type: { $in: typesArray } } },
                { $group: { _id: '$user', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 },
                { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
                { $unwind: '$userInfo' }
            ]);
            return data.map(t => ({
                name: t.userInfo.name || 'Naterpay User', count: t.count, points: t.count * pointsMultiplier
            }));
        }

        // 2. TOP SPENDERS (Bills, VTU, Data, Exams) - 10 points per purchase
        const spenders = await getTopUsersByTxType(
            ['airtime', 'data', 'electricity', 'cable', 'exam', 'education', 'betting', 'insurance'], 10
        );

        // 3. TOP FUNDERS (Deposits) - 5 points per deposit
        const funders = await getTopUsersByTxType(['funding'], 5);

        // 4. TOP MERCHANTS (Receiving payments via Links, QR, POS) - 20 points per sale
        const merchants = await getTopUsersByTxType(['payment_link', 'qr_payment', 'pos'], 20);

        // 5. TOP INVOICERS (Successfully paid invoices) - 20 points per invoice
        const invoicers = await getTopUsersByTxType(['invoice'], 20);

        return reply.send({
            success: true,
            referrers,
            spenders,
            funders,
            merchants,
            invoicers
        });

    } catch (error) {
        console.error('[LEADERBOARD ERROR]:', error);
        return reply.status(500).send({ success: false, message: 'Failed to synchronize global ledger.' });
    }
}

module.exports = { getLeaderboard };
