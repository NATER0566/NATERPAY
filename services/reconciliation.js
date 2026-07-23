const mongoose = require('mongoose');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');

// [1] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let AuditLog;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}

// [2] STRICT MONEY PRECISION HELPER
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    if (isNaN(num)) return 0;
    return num;
};

// [3] IMMUTABLE AUDIT LOGGING ENGINE
async function createAuditLog(params, session = null) {
    if (!AuditLog) return;
    try {
        const log = new AuditLog({
            user: params.user, transactionId: params.transactionId, transactionReference: params.reference,
            amount: params.amount, type: params.type, previousBalance: String(params.previousBalance),
            newBalance: String(params.newBalance), ipAddress: params.ipAddress || '127.0.0.1', 
            userAgent: params.userAgent || 'System Reconciliation Cron',
            status: params.status, source: params.source, details: params.details || {}
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

/* =========================================================================
   REAL GATEWAY STATUS CHECKERS
========================================================================= */

async function checkPaystackStatus(reference) {
    try {
        if (!process.env.PAYSTACK_SECRET_KEY) return 'pending'; // Failsafe
        
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
            timeout: 10000
        });
        
        const status = response.data.data.status;
        if (status === 'success') return 'success';
        if (status === 'failed' || status === 'abandoned' || status === 'cancelled') return 'failed';
        return 'pending';
    } catch (error) {
        // If Paystack returns a 404, it means the transaction reference was generated but the user never loaded the checkout page. (Abandoned)
        if (error.response && error.response.status === 404) return 'failed';
        
        logger.error(`Paystack Requery Error for ${reference}`, error.message);
        return 'pending'; // Keep pending on network errors to try again later
    }
}

async function checkVTPassStatus(reference) {
    try {
        if (!process.env.VTPASS_SECRET_KEY) return 'pending';
        
        const vtpassUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
        const response = await axios.post(`${vtpassUrl}/requery`, { request_id: reference }, {
            headers: { 
                'api-key': process.env.VTPASS_API_KEY,
                'secret-key': process.env.VTPASS_SECRET_KEY
            },
            timeout: 15000
        });

        const code = response.data.code;
        if (code === '000') return 'success';
        if (code === '016') return 'failed'; // Failed transaction
        if (code === '099') return 'pending'; // Still processing
        
        return 'failed';
    } catch (error) {
        logger.error(`VTPass Requery Error for ${reference}`, error.message);
        return 'pending'; 
    }
}

/**
 * Master Status Checker
 */
async function getRealProviderStatus(transaction) {
    const provider = String(transaction.provider || '').toLowerCase();
    const reference = transaction.providerReference || transaction._id.toString();

    if (provider === 'paystack') return await checkPaystackStatus(reference);
    if (provider === 'vtpass') return await checkVTPassStatus(reference);
    
    // Internal transactions shouldn't be pending for > 30 minutes. If they are, they failed.
    if (provider === 'internal') {
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (new Date(transaction.createdAt) < thirtyMinsAgo) return 'failed';
    }

    // Default to pending if we don't recognize the provider to prevent blind refunds
    return 'pending'; 
}

/* =========================================================================
   CORE RECONCILIATION ENGINE (ATOMIC & STRICT)
========================================================================= */

async function reconcileTransactions() {
    try {
        logger.info('[SYSTEM] Starting enterprise transaction reconciliation...');
        
        // Target transactions pending for more than 15 minutes
        const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
        
        // Strict limit to prevent memory exhaustion
        const pendingTransactions = await Transaction.find({
            status: 'pending',
            createdAt: { $lt: fifteenMinutesAgo }
        }).limit(50);
        
        if (pendingTransactions.length === 0) {
            logger.info('[SYSTEM] No stale pending transactions found.');
            return { reconciled: 0, failed: 0 };
        }

        let reconciledSuccess = 0;
        let reconciledFailed = 0;
        
        for (const transaction of pendingTransactions) {
            const realStatus = await getRealProviderStatus(transaction);
            
            if (realStatus === 'pending') continue; // Leave it alone, try again next cron run

            // ATOMIC DATABASE SESSION WRAPPER
            const session = await mongoose.startSession();
            session.startTransaction();

            try {
                // Lock the transaction specifically for this session to prevent race conditions
                const lockedTx = await Transaction.findById(transaction._id).session(session);
                if (lockedTx.status !== 'pending') {
                    await session.abortTransaction(); session.endSession();
                    continue; // Something else processed it
                }

                const wallet = await Wallet.findOne({ user: lockedTx.user }).session(session);
                if (!wallet) throw new Error('Wallet not found');

                const currentAvail = sanitizeAmount(wallet.availableBalance);
                const currentLedger = sanitizeAmount(wallet.balance);
                const txAmount = sanitizeAmount(lockedTx.amount);
                const txFee = sanitizeAmount(lockedTx.fee || 0);
                const totalDeduction = sanitizeAmount(txAmount + txFee);

                // =====================================================================
                // CASE 1: TRANSACTION WAS ACTUALLY SUCCESSFUL
                // =====================================================================
                if (realStatus === 'success') {
                    // If it was a DEPOSIT (Money coming in), credit the user
                    if (['funding', 'wallet_fund'].includes(lockedTx.type)) {
                        wallet.availableBalance = String(currentAvail + txAmount);
                        wallet.balance = String(currentLedger + txAmount);
                        await wallet.save({ session });
                        
                        lockedTx.balanceAfter = String(currentAvail + txAmount);
                    }
                    // If it was a PURCHASE (Money going out), do nothing to wallet (money was deducted upfront)

                    lockedTx.status = 'success';
                    lockedTx.metadata = lockedTx.metadata || {};
                    lockedTx.metadata.reconciledBy = 'System_Auto_Fix';
                    lockedTx.metadata.reconciledAt = new Date();
                    
                    await lockedTx.save({ session });

                    await createAuditLog({
                        user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: txAmount,
                        type: 'reconciliation_success', previousBalance: currentAvail, newBalance: wallet.availableBalance, 
                        status: 'success', source: 'Reconciliation Engine', details: { note: 'Auto-reconciled as successful' }
                    }, session);

                    reconciledSuccess++;
                } 
                // =====================================================================
                // CASE 2: TRANSACTION WAS ABANDONED / FAILED
                // =====================================================================
                else if (realStatus === 'failed') {
                    
                    // If it was a PURCHASE (Airtime, Data, Withdrawal), we must REFUND the user.
                    // DO NOT REFUND 'funding' because the money never left their account in the first place.
                    if (['withdrawal', 'transfer', 'airtime', 'data', 'electricity', 'cable', 'exam', 'education', 'betting', 'insurance'].includes(lockedTx.type)) {
                        wallet.availableBalance = String(currentAvail + totalDeduction);
                        wallet.balance = String(currentLedger + totalDeduction);
                        await wallet.save({ session });
                        
                        lockedTx.balanceAfter = String(currentAvail + totalDeduction);
                        
                        await createAuditLog({
                            user: lockedTx.user, transactionId: lockedTx._id, reference: lockedTx.providerReference, amount: totalDeduction,
                            type: 'reconciliation_refund', previousBalance: currentAvail, newBalance: wallet.availableBalance, 
                            status: 'success', source: 'Reconciliation Engine', details: { note: 'Refunded automatically due to provider failure/abandonment' }
                        }, session);
                    }

                    lockedTx.status = 'failed';
                    lockedTx.metadata = lockedTx.metadata || {};
                    lockedTx.metadata.reconciledBy = 'System_Auto_Fix';
                    lockedTx.metadata.reconciledAt = new Date();
                    lockedTx.metadata.failureReason = 'Abandoned or failed at provider gateway.';
                    
                    await lockedTx.save({ session });
                    reconciledFailed++;
                }
                
                await session.commitTransaction();
                session.endSession();

            } catch (innerError) {
                await session.abortTransaction();
                session.endSession();
                logger.error(`Reconciliation Failed for TX: ${transaction._id}`, innerError);
            }
        }
        
        logger.info(`[SYSTEM] Reconciliation complete: ${reconciledSuccess} successful, ${reconciledFailed} failed/abandoned.`);
        return { reconciled: reconciledSuccess, failed: reconciledFailed };
        
    } catch (error) {
        logger.error('CRITICAL: Reconciliation engine crashed', error);
        throw error;
    }
}

/**
 * Manual reconciliation trigger
 */
async function triggerReconciliation() {
    return reconcileTransactions();
}

module.exports = {
  reconcileTransactions,
  triggerReconciliation
};
