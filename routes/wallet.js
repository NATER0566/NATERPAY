'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const Joi = require('joi');

const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const flutterwave = require('../services/flutterwave');
const { settleFunding } = require('../services/settlement');
const { decrypt } = require('../utils/secure-kyc');

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
const CURRENCIES = ['NGN', 'GHS', 'KES', 'UGX'];
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
function maskSensitive(value) {
    if (Array.isArray(value)) return value.map(maskSensitive);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const sensitive = /authorization|secret|token|key|password/i.test(key);
        return [key, sensitive ? '[REDACTED]' : maskSensitive(item)];
    }));
}
function chargeData(response) {
    return response?.data?.data || response?.data || response || {};
}
function chargeIdFrom(response) {
    const d = chargeData(response);
    return d.id || d.charge_id || d.charge?.id || null;
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
    const message = error.isJoi ? error.details?.[0]?.message : (error.message || fallback);
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

async function createDedicatedAccountForUser(userId) {
    const [user, wallet] = await Promise.all([
        User.findById(userId).select('email name phoneNumber kycVerified bvnVerified ninVerified kycData'),
        Wallet.findOne({ user: userId })
    ]);
    if (!user || !wallet) throw Object.assign(new Error('Wallet not found.'), { status: 404 });
    if (!user.kycVerified || !user.bvnVerified || !user.ninVerified) {
        throw Object.assign(new Error('Complete your KYC - Both BVN and NIN must be verified'), { status: 403 });
    }

    const existing = wallet.virtualAccount;
    if (existing?.provider === PROVIDER && existing.bankName && existing.accountNumber && existing.accountName) {
        return existing;
    }

    const bvn = decrypt(user.kycData?.bvnEncrypted);
    if (!bvn) throw Object.assign(new Error('Verified BVN is unavailable. Please complete KYC again.'), { status: 409 });
    const names = String(user.name || '').trim().split(/\s+/).filter(Boolean);
    const firstname = names.shift() || '';
    const lastname = names.join(' ') || firstname;
    const reference = `NPVA${Date.now()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const account = await flutterwave.createVirtualAccount({
        email: user.email,
        firstname,
        lastname,
        phonenumber: user.phoneNumber,
        bvn,
        reference
    });

    wallet.virtualAccount = {
        provider: PROVIDER,
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        accountReference: account.reference
    };
    await wallet.save();
    return wallet.virtualAccount;
}

async function getVirtualAccount(req, reply) {
    try {
        const user = await User.findById(userIdOf(req)).select('kycVerified bvnVerified ninVerified');
        if (!user) return fail(reply, 404, 'Wallet not found.');
        if (!user.kycVerified || !user.bvnVerified || !user.ninVerified) {
            return fail(reply, 403, 'Complete your KYC - Both BVN and NIN must be verified');
        }
        const virtualAccount = await createDedicatedAccountForUser(userIdOf(req));
        return reply.send({ success: true, virtualAccount });
    } catch (err) {
        return errorReply(reply, err, 'Unable to create your dedicated account from Flutterwave.');
    }
}

async function fundWallet(req, reply) {
    let tx;
    try {
        const schema = Joi.object({
            amount: Joi.number().min(MINIMUM_FUNDING).precision(2).required(),
            currency: Joi.string().valid(...CURRENCIES).default('NGN'),
            method: Joi.string().valid('card', 'transfer', 'ussd', 'opay', 'qr').required()
        }).unknown(false);
        const { error, value } = schema.validate(req.body || {});
        if (error) return fail(reply, 400, error.details[0].message);
        if (!rateLimit(req, 'fund-init', 8)) return fail(reply, 429, 'Too many funding attempts. Please wait and try again.');

        const userId = userIdOf(req);
        if (!userId) return fail(reply, 401, 'Authentication is required.');
        const [user, wallet] = await Promise.all([
            User.findById(userId).select('email name firstName lastName phoneNumber'),
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
            if (money(existing.amount) !== amount || (metaGet(existing.metadata, 'currency') || 'NGN') !== value.currency ||
                metaGet(existing.metadata, 'paymentMethod') !== value.method) {
                return fail(reply, 409, 'This idempotency key was already used for a different funding request.');
            }
            if ([TX.FAILED, 'cancelled'].includes(existing.status)) return fail(reply, 409, 'This funding request was cancelled or failed. Start a new request with a new idempotency key.');
            return reply.send({
                success: true, reused: true,
                paymentReference: existing.providerReference,
                transactionId: metaGet(existing.metadata, 'flutterwaveTransactionId') || null,
                status: existing.status,
                checkoutUrl: metaGet(existing.metadata, 'flutterwave_link') || null,
                nextAction: null
            });
        }

        const reference = `NPF${Date.now()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        tx = new Transaction({
            user: userId, type: 'funding',
            description: 'Wallet funding via Flutterwave',
            amount, fee: 0,             status: TX.PENDING, provider: PROVIDER,
            providerReference: reference, idempotencyKey: key,
            balanceBefore: String(money(wallet.availableBalance)),
            balanceAfter: String(money(wallet.availableBalance)),
            metadata: { paymentProvider: PROVIDER, currency: value.currency, paymentMethod: value.method, fundingAmount: String(amount) }
        });
        await tx.save({ validateBeforeSave: false });

        try {
            const payload = {
                amount,
                currency: value.currency,
                reference,
                method: value.method,
                customer: {
                    email: user.email,
                    name: safeText(user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email, 120),
                    phonenumber: user.phoneNumber,
                    userId: String(userId)
                },
                redirectUrl: `${APP_URL}/fund-wallet.html?tx_ref=${encodeURIComponent(reference)}&status=returned`,
                idempotencyKey: key
            };

            const paymentResponse = await flutterwave.initializePayment(payload);
            logger.info({
                reference,
                flutterwaveResponse: maskSensitive(paymentResponse.rawResponse || paymentResponse)
            }, 'Flutterwave payment initialization response');

            const paymentData = chargeData(paymentResponse);
            const checkoutUrl = typeof paymentData.link === 'string' ? paymentData.link : null;
            const qrCode = paymentResponse.qrCode || paymentData.qr_code || paymentData.qrCode;
            if (value.method === 'qr' && !qrCode) {
                throw new Error('Flutterwave did not return a native NQR image.');
            }
            if (value.method !== 'qr' && !checkoutUrl) {
                throw new Error('Flutterwave did not return a checkout link.');
            }

            tx.providerResponse = { data: paymentData };
            if (paymentResponse.transactionId) metaSet(tx, 'flutterwaveTransactionId', paymentResponse.transactionId);
            metaSet(tx, 'flutterwave_link', checkoutUrl);
            if (qrCode) metaSet(tx, 'flutterwave_qr_code', qrCode);
            await tx.save({ validateBeforeSave: false });

            return reply.send({
                success: true, paymentReference: reference, transactionId: null,
                status: TX.PENDING, checkoutUrl, qrCode: qrCode || null,
                message: 'Payment initialized. Continue to Flutterwave.'
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
        const reference = req.query?.tx_ref || req.query?.reference || req.body?.tx_ref || req.body?.reference;
        const { error, value } = Joi.object({ reference: Joi.string().trim().min(8).max(150).required() }).validate({ reference });
        if (error) return fail(reply, 400, 'A valid payment reference is required.');
        if (!rateLimit(req, 'fund-verify', 20)) return fail(reply, 429, 'Too many verification requests.');
        const tx = await Transaction.findOne({
            providerReference: value.reference, user: userIdOf(req),
            provider: PROVIDER, type: 'funding'
        });
        if (!tx) return fail(reply, 404, 'Funding transaction not found.');
        if (tx.status === TX.SUCCESS) return reply.send({ success: true, status: TX.SUCCESS, credited: false, message: 'Payment was already credited.' });
        if ([TX.FAILED, 'cancelled'].includes(tx.status)) {
            return reply.send({ success: false, status: tx.status, message: 'This payment was cancelled or failed.' });
        }

        const verification = await flutterwave.verifyTransaction(tx);
        if (verification.data) {
            tx.providerResponse = { data: verification.data };
            if (verification.data.id) metaSet(tx, 'flutterwaveTransactionId', verification.data.id);
            await tx.save({ validateBeforeSave: false });
        }

        if (!verification?.verified) {
            if (['failed', 'cancelled'].includes(verification.status)) {
                await Transaction.updateOne({ _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                    { $set: { status: verification.status === 'cancelled' ? 'cancelled' : TX.FAILED, description: 'Flutterwave did not find or rejected this payment.' } });
                return reply.send({ success: false, status: verification.status === 'cancelled' ? 'cancelled' : TX.FAILED, credited: false, message: 'Payment Cancelled - No money was taken.' });
            }
            return reply.send({ success: true, status: TX.PENDING, credited: false, message: 'Payment is still being confirmed. Your wallet has not been credited.' });
        }
        if (['failed', 'cancelled'].includes(verification.status)) {
            await Transaction.updateOne({ _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                { $set: { status: verification.status === 'cancelled' ? 'cancelled' : TX.FAILED, description: 'Flutterwave confirmed payment failure.' } });
            return reply.send({ success: false, status: verification.status, message: 'Flutterwave confirmed that this payment failed.' });
        }
        if (verification.status !== 'success') {
            if (verification.verified && tx.status !== TX.PENDING) {
                tx.status = TX.PENDING;
                tx.description = 'Flutterwave received the payment and is confirming it.';
                await tx.save({ validateBeforeSave: false });
            }
            return reply.send({ success: true, status: TX.PENDING, credited: false, message: 'Payment is awaiting final confirmation.' });
        }
        const result = await creditVerifiedFunding(tx._id, req, 'Flutterwave verification');
        const wallet = await Wallet.findOne({ user: tx.user });
        return reply.send({ success: true, status: TX.SUCCESS, credited: result.credited, balance: wallet?.availableBalance, message: result.credited ? 'Payment verified and wallet credited.' : 'Payment was already processed.' });
    } catch (err) { return errorReply(reply, err, 'Unable to verify the payment.'); }
}

async function cancelFunding(req, reply) {
    try {
        const reference = req.body?.tx_ref || req.body?.reference || req.query?.tx_ref;
        const { error, value } = Joi.object({
            reference: Joi.string().trim().min(8).max(150).required()
        }).validate({ reference });
        if (error) return fail(reply, 400, 'A valid payment reference is required.');

        const tx = await Transaction.findOne({
            providerReference: value.reference,
            user: userIdOf(req),
            provider: PROVIDER,
            type: 'funding'
        });
        if (!tx) return fail(reply, 404, 'Funding transaction not found.');
        if (tx.status === TX.SUCCESS) {
            return reply.send({ success: false, status: TX.SUCCESS, message: 'This payment was already successful and cannot be cancelled.' });
        }
        if (tx.status === 'cancelled') {
            return reply.send({ success: true, status: 'cancelled', message: 'Payment Cancelled - No money was taken.' });
        }

        const verification = await flutterwave.verifyTransaction(tx);
        if (verification.verified && verification.status === 'success') {
            const result = await creditVerifiedFunding(tx._id, req, 'Flutterwave cancellation check');
            return reply.send({ success: true, status: TX.SUCCESS, credited: result.credited, message: 'Payment verified and wallet credited.' });
        }
        if (verification.verified && verification.status === TX.PENDING) {
            return reply.send({ success: false, status: TX.PENDING, message: 'We received your payment, confirming...' });
        }
        if (['cancelled', 'failed'].includes(verification.status)) {
            const nextStatus = verification.status === 'cancelled' ? 'cancelled' : TX.FAILED;
            await Transaction.updateOne(
                { _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                { $set: { status: nextStatus, description: 'Flutterwave confirmed payment failure or cancellation.' } }
            );
            return reply.send({ success: true, status: nextStatus, message: 'Flutterwave confirmed that this payment was not successful.' });
        }
        return reply.send({ success: false, status: TX.PENDING, message: 'Payment status could not be confirmed yet. Please try again shortly.' });
    } catch (err) {
        return errorReply(reply, err, 'Unable to cancel the payment safely.');
    }
}

async function creditVerifiedFunding(transactionId, req, source) {
    return settleFunding(transactionId, req, source);
}

async function checkPending(req, reply) {
    try {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000);
        const pending = await Transaction.find({
            user: userIdOf(req), provider: PROVIDER, type: 'funding',
            status: { $in: [TX.PENDING, TX.PROCESSING] },
            createdAt: { $lt: cutoff }
        }).sort({ createdAt: 1 }).limit(50);
        const results = [];
        for (const tx of pending) {
            const verification = await flutterwave.verifyTransaction(tx);
            if (verification.status === 'success' && verification.verified) {
                if (verification.data) {
                    tx.providerResponse = { data: verification.data };
                    if (verification.data.id) metaSet(tx, 'flutterwaveTransactionId', verification.data.id);
                    await tx.save({ validateBeforeSave: false });
                }
                const credited = await creditVerifiedFunding(tx._id, req, 'Flutterwave reconciliation');
                results.push({ tx_ref: tx.providerReference, status: TX.SUCCESS, credited: credited.credited });
            } else if (['failed', 'cancelled'].includes(verification.status)) {
                await Transaction.updateOne({ _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                    { $set: { status: verification.status === 'cancelled' ? 'cancelled' : TX.FAILED, description: 'Flutterwave confirmed payment failure or cancellation.' } });
                results.push({ tx_ref: tx.providerReference, status: verification.status === 'cancelled' ? 'cancelled' : TX.FAILED });
            } else {
                results.push({ tx_ref: tx.providerReference, status: TX.PENDING });
            }
        }
        return reply.send({ success: true, results });
    } catch (err) {
        return errorReply(reply, err, 'Unable to reconcile pending payments.');
    }
}

async function handleFlutterwaveWebhook(req, reply) {
    try {
        const signature = req.headers['verif-hash'] || req.headers['flutterwave-signature'];
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
        logger.info({ webhook: maskSensitive(payload), reference, chargeId }, 'Flutterwave webhook received');
        if (!reference || !chargeId) return reply.code(200).send({ received: true, ignored: true });

        const tx = await Transaction.findOne({ providerReference: reference, provider: PROVIDER, type: 'funding' });
        if (!tx) {
            logger.warn({ reference, message: 'Webhook reference not found; no wallet credit performed.' });
            return reply.code(200).send({ received: true, ignored: true });
        }

        if (tx.status === TX.SUCCESS) return reply.code(200).send({ received: true, alreadyProcessed: true });

        const storedId = metaGet(tx.metadata, 'flutterwaveTransactionId') || tx.providerResponse?.data?.id;
        if (storedId && String(storedId) !== String(chargeId)) {
            logger.error({ reference, message: 'Webhook transaction ID does not match stored transaction ID.' });
            return reply.code(400).send({ received: false, message: 'Charge ID mismatch.' });
        }
        if (!storedId) {
            tx.providerResponse = { data: { id: String(chargeId) } };
            metaSet(tx, 'flutterwaveTransactionId', chargeId);
            await tx.save({ validateBeforeSave: false });
        }

        const verification = await flutterwave.verifyTransaction(tx);
        if (!verification?.verified || verification.status === 'pending') {
            return reply.code(200).send({ received: true, pendingVerification: true });
        }
        if (['failed', 'cancelled'].includes(verification.status)) {
            await Transaction.updateOne({ _id: tx._id, status: { $in: [TX.PENDING, TX.PROCESSING] } },
                { $set: { status: verification.status, description: 'Flutterwave confirmed payment failure.' } });
            return reply.code(200).send({ received: true, paymentStatus: verification.status });
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
    getWallet, getVirtualAccount, createDedicatedAccountForUser, fundWallet, verifyFunding, cancelFunding, checkPending, handleFlutterwaveWebhook, healthCheck,
    fundManualWallet: disabled('Manual wallet funding'),
    adminApproveManualFunding: disabled('Manual funding approval'),
    adminRejectManualFunding: disabled('Manual funding rejection'),
    withdraw: disabled('Withdrawals'),
    transfer: disabled('Wallet transfers'),
    setPin: disabled('Transaction PIN management'),
    resolveBankAccount: disabled('Bank account resolution')
};
