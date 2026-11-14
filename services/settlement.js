'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const PaymentLink = require('../models/PaymentLink');
const Invoice = require('../models/Invoice');

function amount(value) {
  const parsed = Number(value?.toString?.() ?? value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function decimal(value) {
  return mongoose.Types.Decimal128.fromString(amount(value).toFixed(2));
}

async function settleMerchantPayment(transactionId, request) {
  const session = await mongoose.startSession();
  const result = { settled: false, alreadySettled: false };

  try {
    await session.withTransaction(async () => {
      const transaction = await Transaction.findOneAndUpdate(
        {
          _id: transactionId,
          provider: 'flutterwave',
          status: { $in: ['pending', 'processing'] },
          type: { $in: ['payment_link', 'invoice'] }
        },
        { $set: { status: 'processing' } },
        { new: true, session }
      );

      if (!transaction) {
        const existing = await Transaction.findById(transactionId).session(session);
        result.alreadySettled = existing?.status === 'success';
        return;
      }

      const gross = amount(transaction.metadata?.get?.('grossAmount') || transaction.metadata?.grossAmount);
      const merchantCredit = amount(transaction.metadata?.get?.('merchantCredit') || transaction.metadata?.merchantCredit);
      if (gross <= 0 || merchantCredit <= 0) throw new Error('Invalid settlement amount.');

      let merchantId = transaction.user;
      let paymentLink;
      let invoice;
      if (transaction.type === 'payment_link') {
        const linkId = transaction.metadata?.get?.('linkId') || transaction.metadata?.linkId;
        paymentLink = await PaymentLink.findOne({ linkId }).session(session);
        if (!paymentLink || !paymentLink.isActive || ['paused', 'archived', 'soldout'].includes(paymentLink.status)) {
          throw new Error('Payment link is no longer payable.');
        }
        if (paymentLink.maxTransactions && paymentLink.transactionCount >= paymentLink.maxTransactions) {
          throw new Error('Payment link transaction limit has been reached.');
        }
        if (paymentLink.totalStock !== null && paymentLink.remainingStock <= 0) {
          throw new Error('Payment link is sold out.');
        }
        merchantId = paymentLink.user;
      } else {
        const invoiceId = transaction.metadata?.get?.('invoiceId') || transaction.metadata?.invoiceId;
        invoice = await Invoice.findOne({ invoiceId }).session(session);
        if (!invoice || ['paid', 'cancelled'].includes(invoice.status)) {
          throw new Error('Invoice is no longer payable.');
        }
        merchantId = invoice.user;
      }

      const wallet = await Wallet.findOneAndUpdate(
        { user: merchantId },
        {
          $inc: {
            balance: decimal(merchantCredit),
            availableBalance: decimal(merchantCredit)
          }
        },
        { new: true, session }
      );
      if (!wallet) throw new Error('Merchant wallet not found.');

      const before = amount(wallet.availableBalance) - merchantCredit;
      transaction.user = merchantId;
      transaction.balanceBefore = before.toFixed(2);
      transaction.balanceAfter = amount(wallet.availableBalance).toFixed(2);
      transaction.amount = merchantCredit;
      transaction.status = 'success';
      transaction.description = transaction.type === 'invoice'
        ? `Invoice payment settled: ${invoice.invoiceId}`
        : `Payment link settled: ${paymentLink.title}`;
      await transaction.save({ session, validateBeforeSave: false });

      if (paymentLink) {
        paymentLink.transactionCount = (paymentLink.transactionCount || 0) + 1;
        paymentLink.totalCollected = amount((paymentLink.totalCollected || 0) + gross);
        paymentLink.feesPaid = amount((paymentLink.feesPaid || 0) + gross - merchantCredit);
        if (paymentLink.totalStock !== null) {
          paymentLink.remainingStock = Math.max(0, (paymentLink.remainingStock ?? paymentLink.totalStock) - 1);
          if (paymentLink.remainingStock === 0) paymentLink.status = 'soldout';
        }
        await paymentLink.save({ session });
      }
      if (invoice) {
        invoice.status = 'paid';
        invoice.paidAt = new Date();
        invoice.paymentReference = transaction.providerReference;
        invoice.paymentMethod = 'flutterwave';
        await invoice.save({ session });
      }
      result.settled = true;
      result.balance = String(wallet.availableBalance);
      result.userId = String(merchantId);
    });
  } finally {
    await session.endSession();
  }

  if (result.settled) {
    request?.server?.io?.to(`user:${result.userId}`).emit('wallet:update', { balance: result.balance });
  }
  return result;
}

async function settleFunding(transactionId, request) {
  const session = await mongoose.startSession();
  let result = { credited: false, alreadyProcessed: false };
  try {
    await session.withTransaction(async () => {
      const transaction = await Transaction.findOneAndUpdate(
        { _id: transactionId, provider: 'flutterwave', type: 'funding', status: { $in: ['pending', 'processing'] } },
        { $set: { status: 'success', description: 'Flutterwave payment verified' } },
        { new: true, session }
      );
      if (!transaction) {
        const existing = await Transaction.findById(transactionId).session(session);
        result.alreadyProcessed = existing?.status === 'success';
        return;
      }
      const credit = amount(transaction.amount);
      if (credit <= 0) throw new Error('Invalid transaction amount.');
      const wallet = await Wallet.findOneAndUpdate(
        { user: transaction.user },
        { $inc: { balance: decimal(credit), availableBalance: decimal(credit) } },
        { new: true, session }
      );
      if (!wallet) throw new Error('Wallet not found while crediting verified payment.');
      transaction.balanceBefore = (amount(wallet.availableBalance) - credit).toFixed(2);
      transaction.balanceAfter = amount(wallet.availableBalance).toFixed(2);
      await transaction.save({ session, validateBeforeSave: false });
      result = { credited: true, alreadyProcessed: false, balance: String(wallet.availableBalance), userId: String(transaction.user) };
    });
  } finally {
    await session.endSession();
  }
  if (result.credited) request?.server?.io?.to(`user:${result.userId}`).emit('wallet:update', { balance: result.balance });
  return result;
}

module.exports = { settleMerchantPayment, settleFunding };
