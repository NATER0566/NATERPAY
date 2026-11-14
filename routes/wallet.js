'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const Joi = require('joi');

const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const flutterwave = require('../services/flutterwave');

let AuditLog;
let Notification;
try { AuditLog = require('../models/AuditLog'); } catch (_) {}
try { Notification = require('../models/Notification'); } catch (_) {}

let logger;
try { logger = require('pino')(); }
catch (_) {
    logger = {
        info: (...args) => console.log('[INFO]', ...args),
        warn: (...args) => console.warn('[WARN]', ...args),
        error: (...args) => console.error('[ERROR]', ...args)
    };
}

const PROVIDER = 'flutterwave';
const CURRENCY = 'NGN';
const MINIMUM_FUNDING = 100;
const APP_URL = String(process.env.APP_URL || 'https://naterpay-yrf7.onrender.com').replace(/\/+$/, '');
const TX = Object.freeze({ PENDING: 'pending', PROCESSING: 'processing', SUCCESS: 'success', FAILED: 'failed' });
const rateLimits = new Map();

function userIdOf(req) { return req.user?._id || req.user?.id || null; }
function money(value) {
    const n = Number(value?.toString?.() ?? value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}
function decimal(value) {
    return mongoose.Types.Decimal128.fromString(money(value).toFixed(2));
}
function safeText(value, max = 255) {
    return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}
function metaGet(meta, key) {
    return typeof meta?.get === 'function' ? meta.get(key) : meta?.[key];
}
function metaSet(doc, key, value) {
    if (doc.metadata && typeof doc.metadata.set === 'function') doc.metadata.set(key, String(value));
    else doc.metadata = { ...(doc.metadata?.toObject?.() || doc.metadata || {}), [key]: String(value) };
}
function chargeData(response) {
    return response?.data?.data || response?.data || response || {};
}
function chargeIdFrom(response) {
    const d = chargeData(response);
    return d.id || d.charge_id || d.charge?.id || null;
}
function customerIdFrom(response) {
    const d = chargeData(response);
    return d.id || d.customer_id || d.customer?.id || null;
}
function nextActionFrom(response) {
    return chargeData(response).next_action || null;
}
function redirectUrlFrom(action) {
    if (!action || action.type !== 'redirect_url') return null;
    const raw = action.redirect_url?.url || action.redirect_url || action.url;
    if (typeof raw !== 'string') return null;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' ? url.toString() : null;
    } catch (_) { return null; }
}
function rateLimit(req, action, limit) {
    const key = `${action}:${String(userIdOf(req) || req.ip || 'anonymous')}`;
    const now = Date.now();
    const item = rateLimits.get(key);
    if (!item || item.until <= now) {
        rateLimits.set(key, { count: 1, until: now + 60000 });
        return true;
    }
    item.count += 1;
    return item.count <= limit;
}
function fail(reply, status, message) {
    return reply.code(status).send({ success: false, message });
}
function errorReply(reply, error, fallback) {
    logger.error({ err: error, message: fallback });
    const status = Number(error.statusCode || error.status || (error.isJoi ? 400 : 500));
    const message = error.isJoi ? error.details?.[0]?.message : fallback;
    return fail(reply, status >= 400 && status <= 599 ? status : 500, message || fallback);
}
async function audit(params, session) {
    if (!AuditLog) return;
    try {
        const doc = new AuditLog({
            user: params.user,
            transactionId: params.transactionId,
            transactionReference: params.reference,
            amount: params.amount,
            type: params.type,
            previousBalance: String(params.before),
            newBalance: String(params.after),
            ipAddress: params.ip || 'SYSTEM',
            userAgent: params.ua || 'SYSTEM',
            status: params.status,
            source: params.source || 'Flutterwave',
            details: params.details || {}
        });
        await doc.save(session ? { session, validateBeforeSave: false } : { validateBeforeSave: false });
    } catch (err) {
        // Audit failure must not silently roll back a confirmed customer payment.
        logger.error({ err, message: 'Audit log write failed' });
    }
}
async function notify(user, amount, req, session) {
    if (!Notification) return;
    try {
        const doc = new Notification({
            user,
            title: 'Wallet Funded',
            message: `Your wallet has been credited with ₦${money(amount).toLocaleString('en-NG')}.`,
            type: 'funding',
            isRead: false
        });
        await doc.save(session ? { session } : {});
        // Emit only after the database transaction commits.
        if (!session) req?.server?.io?.to(`user:${user}`).emit('notification:new', doc);
    } catch (err) {
        logger.error({ err, message: 'Notification write failed' });
    }
}
async function getWallet(req, reply) {
    try {
        const wallet = await Wallet.findOne({ user: userIdOf(req) });
        if (!wallet) return fail(reply, 404, 'Wallet not found.');
        return reply.send({ success: true, wallet });
    } catch (err) { return errorReply(reply, err, 'Unable to retrieve wallet.'); }
}

/*
 * Payment method keys are deliberately allow-listed. The V4 Orchestrator
 * accepts a method-specific payment_method object; it is not a hosted checkout
 * session and some methods return payment instructions instead of a URL.
 */
const METHOD_TYPES = Object.freeze({
    card: 'card',
    transfer: 'bank_transfer',
    ussd: 'ussd',
    opay: 'opay'
});

async function fundWallet(req, reply) {
    let tx;
    try {
        const schema = Joi.object({
            amount: Joi.number().min(MINIMUM_FUNDING).precision(2).required(),
            currency: Joi.string().valid(CURRENCY).default(CURRENCY),
            method: Joi.string().valid('card', 'transfer', 'ussd', 'opay').required()
        }).unknown(false);
        const { error, value } = schema.validate(req.body || {});
        if (error) return fail(reply, 400, error.details[0].message);
        if (!rateLimit(req, 'fund-init', 8)) return fail(reply, 429, 'Too many funding attempts. Please wait and try again.');

        const userId = userIdOf(req);
        if (!userId) return fail(reply, 401, 'Authentication is required.');
        const [user, wallet] = await Promise.all([
            User.findById(userId).select('email name firstName lastName'),
            Wallet.findOne({ user: userId })
        ]);
        if (!user?.email) return fail(reply, 400, 'A valid email address is required on your account.');
        if (!wallet) return fail(reply, 404, 'Wallet not found.');

        const amount = money(value.amount);
        const keyHeader = req.headers['x-idempotency-key'];
        const idempotencyKey = typeof keyHeader === 'string' ? keyHeader.trim() : '';
        if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
            return fail(reply, 400, 'The idempotency key must contain 8–128 characters.');
        }
        const key = idempotencyKey || crypto.randomUUID();

        const existing = await Transaction.findOne({ idempotencyKey: key, user: userId, type: 'funding' });
        if (existing) {
            if (money(existing.amount) !== amount || (metaGet(existing.metadata, 'currency') || CURRENCY) !== CURRENCY ||
                metaGet(existing.metadata, 'paymentMethod') !== value.method) {
                return fail(reply, 409, 'This idempotency key was already used for a different funding request.');
            }
            if (existing.status === TX.FAILED) return fail(reply, 409, 'This funding request failed. Start a new request with a new idempotency key.');
            const action = metaGet(existing.metadata, 'nextAction');
            return reply.send({
                success: true, reused: true,
                paymentReference: existing.providerReference,
                chargeId: metaGet(existing.metadata, 'flutterwaveChargeId') || null,
                status: existing.status,
                checkoutUrl: redirectUrlFrom(action),
                nextAction: action || null
            });
        }

        const reference = `NPF${Date.now()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        tx = new Transaction({
            user: userId, type: 'funding',
            description: 'Wallet funding via Flutterwave',
            amount, fee: 0, status: TX.PENDING, provider: PROVIDER,
            providerReference: reference, idempotencyKey: key,
            balanceBefore: String(money(wallet.availableBalance)),
            balanceAfter: String(money(wallet.availableBalance)),
            metadata: { paymentProvider: PROVIDER, currency: CURRENCY, paymentMethod: value.method, fundingAmount: String(amount) }
        });
        await tx.save({ validateBeforeSave: false });

        try {
            const customerResponse = await flutterwave.createCustomer({
                email: user.email,
                name: safeText(user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email, 120)
            }, `naterpay-customer-${String(userId)}`);

            const customerId = customerIdFrom(customerResponse);
            if (!customerId) throw new Error('Flutterwave did not return a customer ID.');

            /*
             * The Orchestrator schema is method-specific. This route sends
             * the selected method type only. If the merchant's enabled method
             * requires additional customer fields, Flutterwave will reject it;
             * no fabricated card, bank or account details are supplied.
             */
            const paymentMethod = { type: METHOD_TYPES[value.method] };
            const payload = {
                amount, currency: CURRENCY, reference,
                customer: { id: customerId },
                payment_method: paymentMethod,
                redirect_url: `${APP_URL}/fund.html?reference=${encodeURIComponent(reference)}`
            };

            const chargeResponse = await flutterwave.createCharge(payload, reference);
            const chargeId = chargeIdFrom(chargeResponse);
            if (!chargeId || !String(chargeId).startsWith('chg_')) {
                throw new Error('Flutterwave did not return a valid charge ID.');
            }

            const action = nextActionFrom(chargeResponse);
            tx.providerResponse = { data: { id: String(chargeId) } };
            metaSet(tx, 'flutterwaveChargeId', chargeId);
            metaSet(tx, 'flutterwaveCustomerId', customerId);
            metaSet(tx, 'nextAction', action || {});
            await tx.save({ validateBeforeSave: false });

            const checkoutUrl = redirectUrlFrom(action);
            const instruction = action?.payment_instruction?.note || action?.payment_instructions?.note || null;
            return reply.send({
                success: true, paymentReference: reference, chargeId,
                status: TX.PENDING, checkoutUrl,
                nextAction: action || null,
                paymentInstruction: instruction,
                message: checkoutUrl ? 'Payment initialized. Continue to Flutterwave.' :
                    instruction ? 'Follow the payment instructions displayed.' :
                    'Payment initialized. Awaiting the next authorization step.'
            });
        } catch (gatewayError) {
            /*
             * A timeout/connection error is ambiguous: the provider may have
             * created the charge. Leave it pending for reconciliation rather
             * than incorrectly marking it failed.
             */
            const code = gatewayError.code || '';
            const ambiguous = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code) ||
                gatewayError.response == null;
            if (!ambiguous) {
                await Transaction.updateOne(
                    { _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                    { $set: { status: TX.FAILED, description: safeText(gatewayError.message || 'Flutterwave initialization failed.') } }
                );
            }
            throw gatewayError;
        }
    } catch (err) {
        return errorReply(reply, err, 'Unable to initialize your Flutterwave payment. If money was debited, do not retry yet; contact support with your reference.');
    }
}

async function verifyFunding(req, reply) {
    try {
        const { error, value } = Joi.object({ reference: Joi.string().trim().min(8).max(150).required() }).validate(req.body || {});
        if (error) return fail(reply, 400, 'A valid payment reference is required.');
        if (!rateLimit(req, 'fund-verify', 20)) return fail(reply, 429, 'Too many verification requests.');
        const tx = await Transaction.findOne({
            providerReference: value.reference, user: userIdOf(req),
            provider: PROVIDER, type: 'funding'
        });
        if (!tx) return fail(reply, 404, 'Funding transaction not found.');
        if (tx.status === TX.SUCCESS) return reply.send({ success: true, status: TX.SUCCESS, credited: false, message: 'Payment was already credited.' });
        if (tx.status === TX.FAILED) return reply.send({ success: false, status: TX.FAILED, message: 'This payment was confirmed as failed.' });

        const verification = await flutterwave.verifyTransaction(tx);
        if (!verification?.verified) {
            return reply.send({ success: true, status: TX.PENDING, credited: false, message: 'Payment is still being confirmed. Your wallet has not been credited.' });
        }
        if (verification.status === 'failed') {
            await Transaction.updateOne({ _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                { $set: { status: TX.FAILED, description: 'Flutterwave confirmed payment failure.' } });
            return reply.send({ success: false, status: TX.FAILED, message: 'Flutterwave confirmed that this payment failed.' });
        }
        if (verification.status !== 'success') {
            return reply.send({ success: true, status: TX.PENDING, credited: false, message: 'Payment is awaiting final confirmation.' });
        }
        const result = await creditVerifiedFunding(tx._id, req, 'Flutterwave verification');
        return reply.send({ success: true, status: TX.SUCCESS, credited: result.credited, message: result.credited ? 'Payment verified and wallet credited.' : 'Payment was already processed.' });
    } catch (err) { return errorReply(reply, err, 'Unable to verify the payment.'); }
}

async function creditVerifiedFunding(transactionId, req, source) {
    const session = await mongoose.startSession();
    let result = { credited: false, alreadyProcessed: false };
    try {
        await session.withTransaction(async () => {
            const tx = await Transaction.findOneAndUpdate({
                _id: transactionId, provider: PROVIDER, type: 'funding',
                status: { $in: [TX.PENDING, TX.PROCESSING] }
            }, { $set: { status: TX.SUCCESS, description: 'Flutterwave payment verified' } },
            { new: true, session });
            if (!tx) {
                const prior = await Transaction.findById(transactionId).session(session);
                result.alreadyProcessed = prior?.status === TX.SUCCESS;
                return;
            }
            const amount = money(tx.amount);
            if (amount <= 0) throw new Error('Invalid transaction amount.');
            const wallet = await Wallet.findOneAndUpdate({ user: tx.user }, {
                $inc: { balance: decimal(amount), availableBalance: decimal(amount) }
            }, { new: true, session });
            if (!wallet) throw new Error('Wallet not found while crediting verified payment.');
            const after = money(wallet.availableBalance);
            const before = Number((after - amount).toFixed(2));
            tx.balanceBefore = String(before);
            tx.balanceAfter = String(after);
            await tx.save({ session, validateBeforeSave: false });
            await audit({
                user: tx.user, transactionId: tx._id, reference: tx.providerReference,
                amount, type: 'funding', before, after, status: TX.SUCCESS,
                ip: req?.ip || 'FLUTTERWAVE', ua: req?.headers?.['user-agent'] || 'SYSTEM', source
            }, session);
            await notify(tx.user, amount, null, session);
            result = { credited: true, alreadyProcessed: false, balance: String(after), userId: String(tx.user) };
        });
        if (result.credited) {
            req?.server?.io?.to(`user:${result.userId}`).emit('wallet:update', { balance: result.balance });
            if (Notification) {
                // Notification persisted in the same transaction; socket event is best-effort.
                req?.server?.io?.to(`user:${result.userId}`).emit('notification:wallet-funded', { amount: result.balance });
            }
        }
        return result;
    } finally { await session.endSession(); }
}

async function handleFlutterwaveWebhook(req, reply) {
    try {
        const signature = req.headers['flutterwave-signature'];
        const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : null);
        if (!rawBody || !signature) return fail(reply, 400, 'Webhook signature data is missing.');
        if (!flutterwave.verifyWebhookSignature(rawBody, signature)) return fail(reply, 401, 'Invalid webhook signature.');

        let payload;
        try { payload = JSON.parse(rawBody.toString('utf8')); }
        catch (_) { return fail(reply, 400, 'Invalid webhook JSON.'); }

        const eventName = String(payload.type || payload.event || '').toLowerCase();
        if (!eventName.includes('charge')) return reply.code(200).send({ received: true, ignored: true });

        const data = payload.data || {};
        const reference = data.reference || data.tx_ref;
        const chargeId = data.id || data.charge_id;
        if (!reference || !chargeId) return reply.code(200).send({ received: true, ignored: true });

        const tx = await Transaction.findOne({ providerReference: reference, provider: PROVIDER, type: 'funding' });
        if (!tx) {
            logger.warn({ reference, message: 'Webhook reference not found; no wallet credit performed.' });
            return reply.code(200).send({ received: true, ignored: true });
        }
        if (tx.status === TX.SUCCESS) return reply.code(200).send({ received: true, alreadyProcessed: true });

        const storedId = metaGet(tx.metadata, 'flutterwaveChargeId') || tx.providerResponse?.data?.id;
        if (storedId && String(storedId) !== String(chargeId)) {
            logger.error({ reference, message: 'Webhook charge ID does not match stored charge ID.' });
            return reply.code(400).send({ received: false, message: 'Charge ID mismatch.' });
        }
        if (!storedId) {
            tx.providerResponse = { data: { id: String(chargeId) } };
            metaSet(tx, 'flutterwaveChargeId', chargeId);
            await tx.save({ validateBeforeSave: false });
        }

        const verification = await flutterwave.verifyTransaction(tx);
        if (!verification?.verified || verification.status === 'pending') {
            return reply.code(200).send({ received: true, pendingVerification: true });
        }
        if (verification.status === 'failed') {
            await Transaction.updateOne({ _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                { $set: { status: TX.FAILED, description: 'Flutterwave confirmed payment failure.' } });
            return reply.code(200).send({ received: true, paymentStatus: TX.FAILED });
        }
        if (verification.status !== 'success') return reply.code(200).send({ received: true, pendingVerification: true });

        const result = await creditVerifiedFunding(tx._id, req, 'Flutterwave webhook');
        return reply.code(200).send({ received: true, credited: result.credited, alreadyProcessed: result.alreadyProcessed });
    } catch (err) {
        logger.error({ err, message: 'Flutterwave webhook processing failed.' });
        return reply.code(500).send({ success: false, message: 'Webhook processing failed.' });
    }
}

function disabled(name) {
    return async function (_req, reply) {
        return reply.code(501).send({ success: false, message: `${name} is not available in this controller.` });
    };
}
async function healthCheck(_req, reply) {
    return reply.send({
        success: true, status: 'Active',
        database: mongoose.connection.readyState === 1 ? 'OK' : 'DOWN',
        flutterwave: process.env.FLUTTERWAVE_SECRET_KEY && process.env.FLUTTERWAVE_PUBLIC_KEY ? 'CONFIGURED' : 'NOT_CONFIGURED',
        timestamp: new Date()
    });
}

module.exports = {
    getWallet, fundWallet, verifyFunding, handleFlutterwaveWebhook, healthCheck,
    fundManualWallet: disabled('Manual wallet funding'),
    adminApproveManualFunding: disabled('Manual funding approval'),
    adminRejectManualFunding: disabled('Manual funding rejection'),
    withdraw: disabled('Withdrawals'),
    transfer: disabled('Wallet transfers'),
    setPin: disabled('Transaction PIN management'),
    resolveBankAccount: disabled('Bank account resolution')
};
