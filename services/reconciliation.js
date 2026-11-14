'use strict';

const Transaction = require('../models/Transaction');
const flutterwave = require('./flutterwave');
const { settleFunding, settleMerchantPayment } = require('./settlement');

let logger;
try {
  logger = require('pino')();
} catch (_) {
  logger = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
  };
}

const RECONCILABLE_TYPES = ['funding', 'payment_link', 'invoice'];
const BATCH_SIZE = 50;

async function reconcileTransactions() {
  const transactions = await Transaction.find({
    provider: 'flutterwave',
    type: { $in: RECONCILABLE_TYPES },
    status: { $in: ['pending', 'processing'] }
  }).sort({ createdAt: 1 }).limit(BATCH_SIZE);

  const results = { reconciled: 0, failed: 0, pending: 0 };
  for (const transaction of transactions) {
    try {
      const verification = await flutterwave.verifyTransaction(transaction);
      if (!verification.verified || verification.status === 'pending') {
        results.pending++;
        continue;
      }
      if (verification.status === 'failed' || verification.status === 'cancelled') {
        await Transaction.updateOne(
          { _id: transaction._id, status: { $in: ['pending', 'processing'] } },
          { $set: { status: verification.status } }
        );
        results.failed++;
        continue;
      }
      if (verification.status !== 'success') {
        results.pending++;
        continue;
      }

      const settled = transaction.type === 'funding'
        ? await settleFunding(transaction._id)
        : await settleMerchantPayment(transaction._id);
      if (settled.credited || settled.settled || settled.alreadyProcessed || settled.alreadySettled) {
        results.reconciled++;
      } else {
        results.pending++;
      }
    } catch (error) {
      logger.warn({ error: error.message, reference: transaction.providerReference }, 'Reconciliation left transaction pending');
      results.pending++;
    }
  }
  logger.info(results, 'Flutterwave reconciliation completed');
  return results;
}

async function triggerReconciliation() {
  return reconcileTransactions();
}

module.exports = { reconcileTransactions, triggerReconciliation };
