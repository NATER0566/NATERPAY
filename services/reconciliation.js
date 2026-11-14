
const mongoose = require('mongoose');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const flutterwave = require('./flutterwave');

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================
let logger;

try {
    logger = require('pino')();
} catch (e) {
    logger = {
        info: (msg, meta = {}) => console.log(JSON.stringify({
            level: 'info',
            timestamp: new Date().toISOString(),
            message: msg,
            ...meta
        })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({
            level: 'warn',
            timestamp: new Date().toISOString(),
            message: msg,
            ...meta
        })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({
            level: 'error',
            timestamp: new Date().toISOString(),
            message: msg,
            error: err?.message || err,
            ...meta
        }))
    };
}

let AuditLog;

try {
    AuditLog = require('../models/AuditLog');
} catch (e) {}

// ============================================================================
// MONEY PRECISION
// ============================================================================
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    return Number.isFinite(num) ? num : 0;
};

// ============================================================================
// AUDIT LOGGING
// ============================================================================
async function createAuditLog(params, session = null) {
    if (!AuditLog) return;

    try {
        const log = new AuditLog({
            user: params.user,
            transactionId: params.transactionId,
            transactionReference: params.reference,
            amount: params.amount,
            type: params.type,
            previousBalance: String(params.previousBalance),
            newBalance: String(params.newBalance),
            ipAddress: params.ipAddress || '127.0.0.1',
            userAgent: params.userAgent || 'System Reconciliation Cron',
            status: params.status,
            source: params.source,
            details: params.details || {}
        });

        if (session) {
            await log.save({ session });
        } else {
            await log.save();
        }
    } catch (e) {
        logger.error('Audit Log Error', e);
    }
}

// ============================================================================
// FLUTTERWAVE STATUS CHECKER
// Uses the central Flutterwave service.
// The service must independently verify the charge with Flutterwave,
// including its reference, amount and currency.
// ============================================================================
async function checkFlutterwaveStatus(transaction) {
    try {
        const result = await flutterwave.verifyTransaction(transaction);

        if (result?.status === 'success' && result.verified === true) return 'success';
        if (['failed', 'cancelled'].includes(result?.status)) return 'failed';

        return 'pending';

    } catch (error) {
        logger.error(
            `Flutterwave reconciliation error for ${transaction.providerReference}`,
            error
        );

        // Network errors and verification errors must not cause blind refunds.
        return 'pending';
    }
}

// ============================================================================
// VTPASS STATUS CHECKER
// Retained as the existing bill-payment provider.
// ============================================================================
async function checkVTPassStatus(reference) {
    try {
        if (!process.env.VTPASS_SECRET_KEY) return 'pending';

        const vtpassUrl =
            process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';

        const response = await axios.post(
            `${vtpassUrl}/requery`,
            { request_id: reference },
            {
                headers: {
                    'api-key': process.env.VTPASS_API_KEY,
                    'secret-key': process.env.VTPASS_SECRET_KEY
                },
                timeout: 15000
            }
        );

        const code = String(response.data.code);

        if (code === '000') return 'success';
        if (code === '016') return 'failed';
        if (code === '099') return 'pending';

        // Unknown provider responses must not trigger refunds.
        return 'pending';

    } catch (error) {
        logger.error(`VTPass requery error for ${reference}`, error);
        return 'pending';
    }
}

// ============================================================================
// MASTER PROVIDER STATUS CHECKER
// ============================================================================
async function getRealProviderStatus(transaction) {
    const provider = String(transaction.provider || '').toLowerCase();

    const reference =
        transaction.providerReference || transaction._id.toString();

    if (provider === 'flutterwave') {
        return checkFlutterwaveStatus(transaction);
    }

    if (provider === 'vtpass') {
        return checkVTPassStatus(reference);
    }

    // Internal transactions older than 30 minutes are considered failed.
    if (provider === 'internal') {
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);

        if (new Date(transaction.createdAt) < thirtyMinsAgo) {
            return 'failed';
        }
    }

    // Unknown providers remain pending.
    return 'pending';
}

// ============================================================================
// CORE RECONCILIATION ENGINE
// ============================================================================
async function reconcileTransactions() {
    try {
        logger.info('[SYSTEM] Starting transaction reconciliation...');

        const twoMinutesAgo =
            new Date(Date.now() - 5 * 60 * 1000);

        const pendingTransactions = await Transaction.find({
            status: { $in: ['pending', 'processing'] },
            provider: 'flutterwave',
            type: 'funding',
            createdAt: { $lt: twoMinutesAgo }
        }).limit(50);

        if (pendingTransactions.length === 0) {
            logger.info('[SYSTEM] No stale pending transactions found.');

            return {
                reconciled: 0,
                failed: 0
            };
        }

        let reconciledSuccess = 0;
        let reconciledFailed = 0;

        for (const transaction of pendingTransactions) {
            const realStatus =
                await getRealProviderStatus(transaction);

            if (realStatus === 'pending') continue;

            const session = await mongoose.startSession();

            try {
                session.startTransaction();

                // Recheck the transaction inside the database transaction.
                const lockedTx = await Transaction.findById(
                    transaction._id
                ).session(session);

                if (!lockedTx || lockedTx.status !== 'pending') {
                    await session.abortTransaction();
                    continue;
                }

                const wallet = await Wallet.findOne({
                    user: lockedTx.user
                }).session(session);

                if (!wallet) {
                    throw new Error('Wallet not found');
                }

                const currentAvail =
                    sanitizeAmount(wallet.availableBalance);

                const currentLedger =
                    sanitizeAmount(wallet.balance);

                const txAmount =
                    sanitizeAmount(lockedTx.amount);

                const txFee =
                    sanitizeAmount(lockedTx.fee || 0);

                const totalDeduction =
                    sanitizeAmount(txAmount + txFee);

                // =================================================================
                // SUCCESSFUL TRANSACTION
                // =================================================================
                if (realStatus === 'success') {

                    if (['funding', 'wallet_fund'].includes(lockedTx.type)) {

                        wallet.availableBalance =
                            String(currentAvail + txAmount);

                        wallet.balance =
                            String(currentLedger + txAmount);

                        await wallet.save({ session });

                        lockedTx.balanceAfter =
                            String(currentAvail + txAmount);
                    }

                    lockedTx.status = 'success';

                    lockedTx.metadata =
                        lockedTx.metadata || {};

                    lockedTx.metadata.reconciledBy =
                        'System_Auto_Fix';

                    lockedTx.metadata.reconciledAt =
                        new Date();

                    await lockedTx.save({ session });

                    await createAuditLog({
                        user: lockedTx.user,
                        transactionId: lockedTx._id,
                        reference: lockedTx.providerReference,
                        amount: txAmount,
                        type: 'reconciliation_success',
                        previousBalance: currentAvail,
                        newBalance: wallet.availableBalance,
                        status: 'success',
                        source: 'Reconciliation Engine',
                        details: {
                            note: 'Transaction independently verified and reconciled.'
                        }
                    }, session);

                    reconciledSuccess++;
                }

                // =================================================================
                // FAILED TRANSACTION
                // =================================================================
                else if (realStatus === 'failed') {

                    const refundableTypes = [
                        'withdrawal',
                        'transfer',
                        'airtime',
                        'data',
                        'electricity',
                        'cable',
                        'exam',
                        'education',
                        'betting',
                        'insurance'
                    ];

                    if (refundableTypes.includes(lockedTx.type)) {

                        wallet.availableBalance =
                            String(currentAvail + totalDeduction);

                        wallet.balance =
                            String(currentLedger + totalDeduction);

                        await wallet.save({ session });

                        lockedTx.balanceAfter =
                            String(currentAvail + totalDeduction);

                        await createAuditLog({
                            user: lockedTx.user,
                            transactionId: lockedTx._id,
                            reference: lockedTx.providerReference,
                            amount: totalDeduction,
                            type: 'reconciliation_refund',
                            previousBalance: currentAvail,
                            newBalance: wallet.availableBalance,
                            status: 'success',
                            source: 'Reconciliation Engine',
                            details: {
                                note: 'Refunded after provider failure verification.'
                            }
                        }, session);
                    }

                    lockedTx.status = 'cancelled';

                    lockedTx.metadata =
                        lockedTx.metadata || {};

                    lockedTx.metadata.reconciledBy =
                        'System_Auto_Fix';

                    lockedTx.metadata.reconciledAt =
                        new Date();

                    lockedTx.metadata.failureReason =
                        'Transaction was not found or was cancelled at the provider.';

                    await lockedTx.save({ session });

                    reconciledFailed++;
                }

                await session.commitTransaction();

            } catch (innerError) {

                if (session.inTransaction()) {
                    await session.abortTransaction();
                }

                logger.error(
                    `Reconciliation failed for TX: ${transaction._id}`,
                    innerError
                );

            } finally {
                await session.endSession();
            }
        }

        logger.info(
            `[SYSTEM] Reconciliation complete: ${reconciledSuccess} successful, ${reconciledFailed} failed.`
        );

        return {
            reconciled: reconciledSuccess,
            failed: reconciledFailed
        };

    } catch (error) {
        logger.error(
            'CRITICAL: Reconciliation engine crashed',
            error
        );

        throw error;
    }
}

// ============================================================================
// MANUAL RECONCILIATION TRIGGER
// ============================================================================
async function triggerReconciliation() {
    return reconcileTransactions();
}

module.exports = {
    reconcileTransactions,
    triggerReconciliation
};
