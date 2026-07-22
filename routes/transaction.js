const mongoose = require('mongoose');
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

// [3] READ-OPTIMIZED RATE LIMITING ENGINE (Data Scraping Protection)
const Redis = require('ioredis');
const redisClient = (process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

// Automatically sweep memory to prevent RAM leaks
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkReadRateLimit(request, action = 'read_tx') {
    const userId = request.user ? request.user._id : 'anon';
    const limit = 60; // Generous 60 requests per minute for reading data
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const userKey = `rate_${action}_user_${userId}`;
        if (!fallbackRateLimits.has(userKey)) {
            fallbackRateLimits.set(userKey, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(userKey);
        if (now > data.resetTime) {
            fallbackRateLimits.set(userKey, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const userKey = `rate:${action}:user:${userId}`;
            const count = await redisClient.incr(userKey);
            if (count === 1) await redisClient.expire(userKey, windowSeconds);
            return count <= limit;
        } catch (err) {
            return executeFallback();
        }
    } else {
        return executeFallback();
    }
}

// [4] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) {
        return reply.status(400).send({ success: false, message: error.details[0].message });
    }
    logger.error(error.message, error);
    reply.status(error.status || 500).send({ success: false, message: error.message || defaultMessage });
}

// =========================================================================
// HELPER: SECURE CASH FLOW DETERMINATION
// =========================================================================
function determineCashFlow(type, description) {
    const txType = String(type || '').toLowerCase();
    const desc = String(description || '').toLowerCase();

    // Specific actions that mean money physically entered the user's wallet
    if (['funding', 'invoice', 'payment_link', 'salary', 'bonus', 'refund', 'referral_bonus'].includes(txType)) {
        return 'in';
    } 
    // Catch Admin Credits explicitly based on description
    else if (desc.includes('admin credit')) {
        return 'in';
    }
    // If it's a P2P transfer, we check the description string saved in the ledger
    else if (txType === 'transfer') {
        if (desc.includes('received') || desc.includes('from')) {
            return 'in';
        }
    }
    
    // Default to money going out (withdrawals, airtime, data, transfers sent)
    return 'out';
}

/* =========================================================================
   GET USER TRANSACTIONS LIST
========================================================================= */
async function getTransactions(request, reply) {
    try {
        // [5] Strict Validation
        const schema = Joi.object({
            type: Joi.string().optional(),
            status: Joi.string().optional(),
            limit: Joi.number().integer().min(1).max(500).default(50)
        });
        const { error, value } = schema.validate(request.query);
        if (error) throw error;

        // [6] Anti-Scraping Lock
        if (!await checkReadRateLimit(request)) throw { status: 429, message: 'Too Many Requests.' };

        const options = { limit: value.limit };
        if (value.type) options.type = value.type;
        if (value.status) options.status = value.status;
        
        let transactions = [];
        
        // Failsafe: Ensures it works whether findByUser exists as a static method or not
        if (typeof Transaction.findByUser === 'function') {
            transactions = await Transaction.findByUser(request.user._id, options);
        } else {
            const query = { user: request.user._id };
            if (value.type) query.type = value.type;
            if (value.status) query.status = value.status;
            transactions = await Transaction.find(query)
                .sort({ createdAt: -1 })
                .limit(value.limit);
        }
        
        reply.send({
            success: true,
            transactions: transactions.map(tx => ({
                _id: tx._id,
                date: tx.createdAt,
                type: tx.type,
                subtype: tx.subtype,
                description: tx.description,
                amount: tx.amount ? tx.amount.toString() : '0',
                fee: tx.fee ? tx.fee.toString() : '0',
                totalDeduction: tx.totalDeduction ? tx.totalDeduction.toString() : '0',
                balanceBefore: tx.balanceBefore ? tx.balanceBefore.toString() : '0',
                balanceAfter: tx.balanceAfter ? tx.balanceAfter.toString() : '0',
                status: tx.status,
                provider: tx.provider,
                providerReference: tx.providerReference,
                serviceDetails: tx.serviceDetails,
                flow: determineCashFlow(tx.type, tx.description) 
            }))
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch transactions'); }
}

/* =========================================================================
   GET SINGLE TRANSACTION DOSSIER
========================================================================= */
async function getTransaction(request, reply) {
    try {
        const schema = Joi.object({ id: Joi.string().required() });
        const { error, value } = schema.validate(request.params);
        if (error) throw error;

        if (!await checkReadRateLimit(request)) throw { status: 429, message: 'Too Many Requests.' };

        const transaction = await Transaction.findOne({
            _id: value.id,
            user: request.user._id
        });
        
        if (!transaction) throw { status: 404, message: 'Transaction not found' };
        
        // Convert mongoose document to plain object to attach custom flow rules
        const txObj = transaction.toObject ? transaction.toObject() : transaction;
        
        txObj.flow = determineCashFlow(txObj.type, txObj.description);
        if(txObj.amount) txObj.amount = txObj.amount.toString();
        if(txObj.fee) txObj.fee = txObj.fee.toString();
        if(txObj.totalDeduction) txObj.totalDeduction = txObj.totalDeduction.toString(); 
        if(txObj.balanceBefore) txObj.balanceBefore = txObj.balanceBefore.toString();
        if(txObj.balanceAfter) txObj.balanceAfter = txObj.balanceAfter.toString();

        reply.send({
            success: true,
            transaction: txObj
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch transaction details'); }
}

module.exports = {
  getTransactions,
  getTransaction
};
