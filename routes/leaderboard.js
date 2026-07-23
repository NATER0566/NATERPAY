const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Joi = require('joi'); // [1] Strict Request Validation

// [2] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

// [3] REDIS / MEMORY RATE LIMITING ENGINE (Anti-DDoS Protection)
let Redis;
try { Redis = require('ioredis'); } catch(e) {}
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 15) {
    const identifier = request.user ? request.user._id : request.ip;
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const key = `rate_${action}_${identifier}`;
        if (!fallbackRateLimits.has(key)) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(key);
        if (now > data.resetTime) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const key = `rate:${action}:${identifier}`;
            const count = await redisClient.incr(key);
            if (count === 1) await redisClient.expire(key, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

// [4] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 500).send({ success: false, message: error.message || defaultMessage });
}

// [5] ENTERPRISE CACHE ENGINE (Prevents Database Collapse from Heavy Aggregations)
let cachedLeaderboard = {
    data: null,
    timestamp: 0
};
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 Minutes

/* =========================================================================
   GET LEADERBOARD
========================================================================= */
async function getLeaderboard(request, reply) {
    try {
        if (!await checkRateLimit(request, 'fetch_leaderboard', 30)) throw { status: 429, message: 'Too many requests.' };

        // CACHE INTERCEPTOR: Return instant data if cache is fresh
        if (cachedLeaderboard.data && (Date.now() - cachedLeaderboard.timestamp < CACHE_DURATION_MS)) {
            return reply.send(cachedLeaderboard.data);
        }

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
        const funders = await getTopUsersByTxType(['funding', 'wallet_fund'], 5);

        // 4. TOP MERCHANTS (Receiving payments via Links, QR, POS) - 20 points per sale
        const merchants = await getTopUsersByTxType(['payment_link', 'qr_payment', 'pos'], 20);

        // 5. TOP INVOICERS (Successfully paid invoices) - 20 points per invoice
        const invoicers = await getTopUsersByTxType(['invoice'], 20);

        const responsePayload = {
            success: true,
            referrers,
            spenders,
            funders,
            merchants,
            invoicers
        };

        // WRITE TO CACHE
        cachedLeaderboard = {
            data: responsePayload,
            timestamp: Date.now()
        };

        return reply.send(responsePayload);

    } catch (error) { handleError(reply, error, 'Failed to synchronize global ledger.'); }
}

module.exports = { getLeaderboard };
