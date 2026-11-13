
'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const Joi = require('joi');

const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const config = require('../config');
const flutterwave = require('../services/flutterwave');

let AuditLog;
let Notification;
let Redis;

try {
    AuditLog = require('../models/AuditLog');
} catch (_) {}

try {
    Notification = require('../models/Notification');
} catch (_) {}

try {
    Redis = require('ioredis');
} catch (_) {}

let logger;

try {
    logger = require('pino')();
} catch (_) {
    logger = {
        info: (...args) => console.log('[INFO]', ...args),
        warn: (...args) => console.warn('[WARN]', ...args),
        error: (...args) => console.error('[ERROR]', ...args)
    };
}

const TX_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SUCCESS: 'success',
    FAILED: 'failed'
};

const PROVIDER = 'flutterwave';
const CURRENCY = 'NGN';
const MINIMUM_FUNDING = 100;

const redisClient =
    Redis && process.env.REDIS_URL
        ? new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 2,
            enableReadyCheck: true
        })
        : null;

const fallbackRateLimits = new Map();

const APP_URL = (
    config.appUrl ||
    process.env.APP_URL ||
    'https://naterpay-yrf7.onrender.com'
).replace(/\/+$/, '');


// ============================================================
// 1. GENERAL HELPERS
// ============================================================

function parseDecimal(value) {
    if (value === null || value === undefined) return 0;

    if (value.$numberDecimal !== undefined) {
        return Number(value.$numberDecimal);
    }

    return Number(value.toString()) || 0;
}

function decimal128(value) {
    return mongoose.Types.Decimal128.fromString(
        Number(value).toFixed(2)
    );
}

function sanitizeAmount(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Invalid monetary amount.');
    }

    return Number(amount.toFixed(2));
}

function sanitizeText(value) {
    return String(value || '')
        .replace(/[<>]/g, '')
        .trim()
        .substring(0, 255);
}

function getRequestUserId(request) {
    return request.user?._id || request.user?.id;
}

function getChargeData(response) {
    return response?.data?.data ||
        response?.data ||
        response ||
        {};
}

function getCustomerId(response) {
    const data = getChargeData(response);

    return (
        data.customer_id ||
        data.id ||
        data.customer?.id ||
        null
    );
}

function getChargeId(response) {
    const data = getChargeData(response);

    return (
        data.id ||
        data.charge_id ||
        data.charge?.id ||
        null
    );
}

function getNextAction(response) {
    const data = getChargeData(response);

    return (
        data.next_action ||
        data.nextAction ||
        data.charge?.next_action ||
        null
    );
}

function getRedirectUrl(nextAction) {
    if (!nextAction || typeof nextAction !== 'object') {
        return null;
    }

    const actionType = String(
        nextAction.type ||
        nextAction.action ||
        ''
    ).toLowerCase();

    if (
        actionType.includes('redirect') ||
        nextAction.redirect_url ||
        nextAction.redirectUrl
    ) {
        const url =
            nextAction.redirect_url ||
            nextAction.redirectUrl ||
            nextAction.url;

        if (typeof url === 'string') {
            try {
                const parsed = new URL(url);

                if (
                    parsed.protocol === 'https:' &&
                    parsed.hostname
                ) {
                    return parsed.toString();
                }
            } catch (_) {}
        }
    }

    return null;
}

function handleError(reply, error, fallbackMessage) {
    const statusCode =
        error.statusCode ||
        error.status ||
        (error.isJoi ? 400 : 400);

    const message = error.isJoi
        ? error.details?.[0]?.message
        : (
            error.response?.data?.error?.message ||
            error.response?.data?.message ||
            error.message ||
            fallbackMessage
        );

    logger.error({
        message: fallbackMessage || 'Wallet operation failed',
        error: message
    });

    return reply.code(statusCode).send({
        success: false,
        message: message || fallbackMessage
    });
}


// ============================================================
// 2. RATE LIMITING
// ============================================================

async function checkRateLimit(request, action, limit = 10) {
    const userId = getRequestUserId(request) || 'anonymous';
    const key = `rate:${action}:${userId}`;

    if (redisClient && redisClient.status === 'ready') {
        try {
            const count = await redisClient.incr(key);

            if (count === 1) {
                await redisClient.expire(key, 60);
            }

            return count <= limit;
        } catch (error) {
            logger.error({
                message: 'Redis rate-limit error',
                error: error.message
            });
        }
    }

    const now = Date.now();
    const existing = fallbackRateLimits.get(key);

    if (!existing || now > existing.resetTime) {
        fallbackRateLimits.set(key, {
            count: 1,
            resetTime: now + 60000
        });

        return true;
    }

    existing.count += 1;

    return existing.count <= limit;
}


// ============================================================
// 3. AUDIT AND NOTIFICATIONS
// ============================================================

async function createAuditLog(params, session = null) {
    if (!AuditLog) return;

    try {
        const log = new AuditLog({
            user: params.user,
            transactionId: params.transactionId,
            transactionReference: params.reference,
            amount: params.amount,
            type: params.type,
            previousBalance: String(params.previousBalance ?? '0'),
            newBalance: String(params.newBalance ?? '0'),
            ipAddress: params.ipAddress || 'SYSTEM',
            userAgent: params.userAgent || 'SYSTEM',
            status: params.status,
            source: params.source || 'API',
            details: params.details || {}
        });

        if (session) {
            await log.save({
                session,
                validateBeforeSave: false
            });
        } else {
            await log.save({
                validateBeforeSave: false
            });
        }
    } catch (error) {
        logger.error({
            message: 'Audit log creation failed',
            error: error.message
        });
    }
}

async function sendSystemNotification(
    userId,
    title,
    message,
    type,
    request,
    session = null
) {
    if (!Notification) return;

    try {
        const notification = new Notification({
            user: userId,
            title,
            message: sanitizeText(message),
            type,
            isRead: false
        });

        if (session) {
            await notification.save({ session });
        } else {
            await notification.save();
        }

        request?.server?.io
            ?.to(`user:${userId}`)
            .emit('notification:new', notification);

    } catch (error) {
        logger.error({
            message: 'Notification creation failed',
            error: error.message
        });
    }
}


// ============================================================
// 4. TRANSACTION FAILURE
// ============================================================

async function failTransactionStrictly(
    transactionId,
    reason,
    request,
    source = 'API'
) {
    const transaction = await Transaction.findOneAndUpdate(
        {
            _id: transactionId,
            status: {
                $in: [
                    TX_STATUS.PENDING,
                    TX_STATUS.PROCESSING
                ]
            }
        },
        {
            $set: {
                status: TX_STATUS.FAILED,
                description: sanitizeText(reason)
            }
        },
        { new: true }
    );

    if (!transaction) return null;

    await createAuditLog({
        user: transaction.user,
        transactionId: transaction._id,
        reference: transaction.providerReference,
        amount: parseDecimal(transaction.amount),
        type: transaction.type,
        previousBalance: transaction.balanceBefore,
        newBalance: transaction.balanceAfter,
        ipAddress: request?.ip || 'SYSTEM',
        userAgent: request?.headers?.['user-agent'] || 'SYSTEM',
        status: TX_STATUS.FAILED,
        source
    });

    return transaction;
}


// ============================================================
// 5. CENTRALIZED, ATOMIC WALLET CREDIT
//
// Both verification and webhook processing use this function.
// The transaction status guard prevents duplicate credits.
// ============================================================

async function creditVerifiedFunding(
    transactionId,
    request,
    source = 'Flutterwave'
) {
    const session = await mongoose.startSession();

    let result = {
        credited: false,
        alreadyProcessed: false,
        balance: null
    };

    try {
        await session.withTransaction(async () => {
            const transaction = await Transaction.findOneAndUpdate(
                {
                    _id: transactionId,
                    provider: PROVIDER,
                    type: 'funding',
                    status: {
                        $in: [
                            TX_STATUS.PENDING,
                            TX_STATUS.PROCESSING
                        ]
                    }
                },
                {
                    $set: {
                        status: TX_STATUS.SUCCESS,
                        description: 'Flutterwave payment verified'
                    }
                },
                {
                    new: true,
                    session
                }
            );

            if (!transaction) {
                const existing = await Transaction.findById(
                    transactionId
                ).session(session);

                result.alreadyProcessed =
                    existing?.status === TX_STATUS.SUCCESS;

                return;
            }

            const creditAmount = sanitizeAmount(
                parseDecimal(transaction.amount)
            );

            const wallet = await Wallet.findOneAndUpdate(
                { user: transaction.user },
                {
                    $inc: {
                        balance: decimal128(creditAmount),
                        availableBalance: decimal128(creditAmount)
                    }
                },
                {
                    new: true,
                    session
                }
            );

            if (!wallet) {
                throw new Error(
                    'Wallet not found while processing verified payment.'
                );
            }

            const newBalance = parseDecimal(wallet.availableBalance);
            const previousBalance = Number(
                (newBalance - creditAmount).toFixed(2)
            );

            transaction.balanceBefore = String(previousBalance);
            transaction.balanceAfter = String(newBalance);

            await transaction.save({
                session,
                validateBeforeSave: false
            });

            await createAuditLog({
                user: transaction.user,
                transactionId: transaction._id,
                reference: transaction.providerReference,
                amount: creditAmount,
                type: 'funding',
                previousBalance,
                newBalance,
                ipAddress: request?.ip || 'FLUTTERWAVE',
                userAgent:
                    request?.headers?.['user-agent'] || 'SYSTEM',
                status: TX_STATUS.SUCCESS,
                source
            }, session);

            await sendSystemNotification(
                transaction.user,
                'Wallet Funded',
                `Your wallet has been credited with ₦${creditAmount.toLocaleString()}.`,
                'funding',
                request,
                session
            );

            result = {
                credited: true,
                alreadyProcessed: false,
                balance: String(newBalance),
                amount: creditAmount,
                userId: transaction.user
            };
        });

        if (result.credited) {
            request?.server?.io
                ?.to(`user:${result.userId}`)
                .emit('wallet:update', {
                    balance: result.balance
                });
        }

        return result;

    } finally {
        await session.endSession();
    }
}


// ============================================================
// 6. GET WALLET
//
// Does not fabricate virtual accounts or BVN details.
// ============================================================

async function getWallet(request, reply) {
    try {
        const userId = getRequestUserId(request);

        const wallet = await Wallet.findOne({
            user: userId
        });

        if (!wallet) {
            return reply.code(404).send({
                success: false,
                message: 'Wallet not found.'
            });
        }

        return reply.send({
            success: true,
            wallet
        });

    } catch (error) {
        return handleError(
            reply,
            error,
            'Failed to fetch wallet.'
        );
    }
}


// ============================================================
// 7. INITIALIZE FLUTTERWAVE V4 FUNDING
//
// Expected request:
// {
//   "amount": 1000,
//   "currency": "NGN",
//   "paymentMethod": { ...V4 payment-method details... }
// }
//
// paymentMethod is passed to the existing V4 service.
// The frontend will be aligned to this contract separately.
// ============================================================

async function fundWallet(request, reply) {
    let transaction;

    try {
        const schema = Joi.object({
            amount: Joi.number()
                .min(MINIMUM_FUNDING)
                .precision(2)
                .required(),

            currency: Joi.string()
                .valid(CURRENCY)
                .default(CURRENCY),

            paymentMethod: Joi.object()
                .required(),

            method: Joi.string()
                .optional()
        });

        const { error, value } = schema.validate(
            request.body || {},
            { abortEarly: true }
        );

        if (error) {
            return reply.code(400).send({
                success: false,
                message: error.details[0].message
            });
        }

        if (!await checkRateLimit(request, 'fund_init')) {
            return reply.code(429).send({
                success: false,
                message: 'Too many funding attempts. Please wait.'
            });
        }

        const userId = getRequestUserId(request);

        const user = await User.findById(userId);

        if (!user || !user.email) {
            throw new Error(
                'A valid customer email is required for payment.'
            );
        }

        const wallet = await Wallet.findOne({
            user: userId
        });

        if (!wallet) {
            throw new Error('Wallet not found.');
        }

        const amount = sanitizeAmount(value.amount);
        const currency = value.currency;

        const idempotencyKey =
            request.headers['x-idempotency-key'] ||
            crypto.randomUUID();

        if (
            typeof idempotencyKey !== 'string' ||
            idempotencyKey.length > 128
        ) {
            return reply.code(400).send({
                success: false,
                message: 'Invalid idempotency key.'
            });
        }

        const existingTransaction = await Transaction.findOne({
            idempotencyKey,
            user: userId,
            type: 'funding'
        });

        if (existingTransaction) {
            if (existingTransaction.status === TX_STATUS.FAILED) {
                return reply.code(409).send({
                    success: false,
                    message: 'This funding request has already failed. Start a new funding request.'
                });
            }

            const existingMetadata =
                existingTransaction.metadata;

            const existingChargeId =
                existingMetadata?.get?.('flutterwaveChargeId') ||
                existingMetadata?.flutterwaveChargeId;

            return reply.send({
                success: true,
                reused: true,
                paymentReference:
                    existingTransaction.providerReference,
                chargeId: existingChargeId || null,
                status: existingTransaction.status,
                message: 'Existing funding request returned.'
            });
        }

        const reference =
            `NPF_${Date.now()}_${crypto.randomBytes(6)
                .toString('hex')
                .toUpperCase()}`;

        const currentBalance = parseDecimal(
            wallet.availableBalance
        );

        // No invented or hardcoded gateway fee.
        // The wallet is credited with the requested amount only.

        transaction = new Transaction({
            user: userId,
            type: 'funding',
            description: 'Wallet funding via Flutterwave V4',
            amount,
            fee: 0,
            status: TX_STATUS.PENDING,
            provider: PROVIDER,
            providerReference: reference,
            idempotencyKey,
            balanceBefore: String(currentBalance),
            balanceAfter: String(currentBalance),
            metadata: {
                paymentProvider: PROVIDER,
                currency,
                paymentMethod: value.method || 'customer-selected',
                fundingAmount: String(amount)
            }
        });

        await transaction.save({
            validateBeforeSave: false
        });

        try {
            // Create/retrieve the customer through the existing
            // Flutterwave V4 OAuth service.

            const customerResponse =
                await flutterwave.createCustomer({
                    email: user.email,
                    name:
                        user.name ||
                        `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
                        user.email,
                    idempotencyKey: `customer_${userId}`
                });

            const customerId = getCustomerId(
                customerResponse
            );

            if (!customerId) {
                throw new Error(
                    'Flutterwave did not return a customer ID.'
                );
            }

            // Create the charge using the existing V4 service.
            // The service handles OAuth and API request headers.

            const chargeResponse =
                await flutterwave.createCharge({
                    amount,
                    currency,
                    reference,
                    customer: {
                        id: customerId
                    },
                    payment_method: value.paymentMethod,
                    redirect_url: `${APP_URL}/fund.html`,
                    idempotencyKey: reference
                });

            const chargeId = getChargeId(chargeResponse);

            if (!chargeId) {
                throw new Error(
                    'Flutterwave did not return a charge ID.'
                );
            }

            const nextAction = getNextAction(
                chargeResponse
            );

            const checkoutUrl = getRedirectUrl(
                nextAction
            );

            transaction.providerResponse = {
                data: {
                    id: chargeId
                }
            };

            if (transaction.metadata?.set) {
                transaction.metadata.set(
                    'flutterwaveChargeId',
                    String(chargeId)
                );

                transaction.metadata.set(
                    'flutterwaveCustomerId',
                    String(customerId)
                );
            } else {
                transaction.metadata = {
                    ...(transaction.metadata || {}),
                    flutterwaveChargeId: String(chargeId),
                    flutterwaveCustomerId: String(customerId)
                };
            }

            await transaction.save({
                validateBeforeSave: false
            });

            return reply.send({
                success: true,
                paymentReference: reference,
                chargeId,
                status: TX_STATUS.PENDING,
                checkoutUrl,
                nextAction: nextAction || null,
                message: checkoutUrl
                    ? 'Payment initialized. Continue to the payment page.'
                    : 'Payment initialized. Complete the required payment action.'
            });

        } catch (gatewayError) {
            await failTransactionStrictly(
                transaction._id,
                gatewayError.message ||
                    'Flutterwave payment initialization failed.',
                request,
                'Flutterwave V4 initialization'
            );

            throw gatewayError;
        }

    } catch (error) {
        return handleError(
            reply,
            error,
            'Failed to initialize Flutterwave payment.'
        );
    }
}


// ============================================================
// 8. VERIFY FLUTTERWAVE FUNDING
//
// Uses services/flutterwave.js verifyTransaction().
// The frontend does not decide whether a payment succeeded.
// ============================================================

async function verifyFunding(request, reply) {
    try {
        const schema = Joi.object({
            reference: Joi.string()
                .trim()
                .min(5)
                .max(150)
                .required()
        });

        const { error, value } = schema.validate(
            request.body || {}
        );

        if (error) {
            return reply.code(400).send({
                success: false,
                message: 'A valid payment reference is required.'
            });
        }

        if (!await checkRateLimit(request, 'verify', 20)) {
            return reply.code(429).send({
                success: false,
                message: 'Too many verification requests.'
            });
        }

        const userId = getRequestUserId(request);

        const transaction = await Transaction.findOne({
            providerReference: value.reference,
            user: userId,
            provider: PROVIDER,
            type: 'funding'
        });

        if (!transaction) {
            return reply.code(404).send({
                success: false,
                message: 'Funding transaction not found.'
            });
        }

        if (transaction.status === TX_STATUS.SUCCESS) {
            return reply.send({
                success: true,
                status: TX_STATUS.SUCCESS,
                message: 'This payment has already been credited.'
            });
        }

        if (transaction.status === TX_STATUS.FAILED) {
            return reply.send({
                success: false,
                status: TX_STATUS.FAILED,
                message: 'This payment was unsuccessful.'
            });
        }

        const verification =
            await flutterwave.verifyTransaction(transaction);

        if (!verification || verification.verified !== true) {
            return reply.send({
                success: true,
                status: TX_STATUS.PENDING,
                message: 'Payment is still being confirmed. Your wallet has not been credited.'
            });
        }

        if (verification.status === TX_STATUS.FAILED) {
            await failTransactionStrictly(
                transaction._id,
                'Flutterwave confirmed that payment failed.',
                request,
                'Flutterwave verification'
            );

            return reply.send({
                success: false,
                status: TX_STATUS.FAILED,
                message: 'Flutterwave confirmed that the payment failed.'
            });
        }

        if (verification.status !== TX_STATUS.SUCCESS) {
            return reply.send({
                success: true,
                status: TX_STATUS.PENDING,
                message: 'Payment is awaiting final confirmation.'
            });
        }

        const creditResult = await creditVerifiedFunding(
            transaction._id,
            request,
            'Flutterwave verification'
        );

        return reply.send({
            success: true,
            status: TX_STATUS.SUCCESS,
            credited: creditResult.credited,
            message: creditResult.credited
                ? 'Payment verified and wallet credited successfully.'
                : 'Payment was already processed.'
        });

    } catch (error) {
        return handleError(
            reply,
            error,
            'Failed to verify Flutterwave payment.'
        );
    }
}


// ============================================================
// 9. FLUTTERWAVE V4 WEBHOOK
//
// Requires the original raw HTTP request body.
// Do not calculate the signature from JSON.stringify(request.body).
// ============================================================

async function handleFlutterwaveWebhook(request, reply) {
    try {
        const signature =
            request.headers['flutterwave-signature'];

        // This must be the exact original request bytes.
        // server.js must expose rawBody for this webhook route.

        const rawBody =
            request.rawBody ||
            (Buffer.isBuffer(request.body)
                ? request.body
                : null);

        if (!rawBody || !signature) {
            logger.warn(
                'Flutterwave webhook rejected: raw body or signature missing.'
            );

            return reply.code(400).send({
                success: false,
                message: 'Webhook signature data is missing.'
            });
        }

        const signatureValid =
            flutterwave.verifyWebhookSignature(
                rawBody,
                signature
            );

        if (!signatureValid) {
            logger.warn(
                'Flutterwave webhook signature verification failed.'
            );

            return reply.code(401).send({
                success: false,
                message: 'Invalid webhook signature.'
            });
        }

        let payload;

        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch (_) {
            return reply.code(400).send({
                success: false,
                message: 'Invalid webhook payload.'
            });
        }

        const event = payload.event;
        const data = payload.data || {};

        // Ignore unrelated event types.
        if (
            !event ||
            !String(event).toLowerCase().includes('charge')
        ) {
            return reply.code(200).send({
                received: true,
                ignored: true
            });
        }

        const reference =
            data.reference ||
            data.tx_ref ||
            data.payment_reference;

        const chargeId =
            data.id ||
            data.charge_id;

        if (!reference || !chargeId) {
            return reply.code(200).send({
                received: true,
                ignored: true,
                message: 'Webhook has no matching payment reference.'
            });
        }

        const transaction = await Transaction.findOne({
            providerReference: reference,
            provider: PROVIDER,
            type: 'funding'
        });

        // Unknown references are not credited automatically.
        // This prevents arbitrary customer-email-based deposits.

        if (!transaction) {
            logger.warn({
                message: 'Flutterwave webhook has no matching local transaction.',
                reference
            });

            return reply.code(200).send({
                received: true,
                ignored: true
            });
        }

        if (transaction.status === TX_STATUS.SUCCESS) {
            return reply.code(200).send({
                received: true,
                alreadyProcessed: true
            });
        }

        // Save the charge ID in the location expected by
        // services/flutterwave.js verifyTransaction().

        transaction.providerResponse = {
            data: {
                id: String(chargeId)
            }
        };

        if (transaction.metadata?.set) {
            transaction.metadata.set(
                'flutterwaveChargeId',
                String(chargeId)
            );
        } else {
            transaction.metadata = {
                ...(transaction.metadata || {}),
                flutterwaveChargeId: String(chargeId)
            };
        }

        await transaction.save({
            validateBeforeSave: false
        });

        // Never credit from the webhook payload alone.
        // Retrieve and verify the charge through the V4 service.

        const verification =
            await flutterwave.verifyTransaction(transaction);

        if (!verification || verification.verified !== true) {
            logger.warn({
                message: 'Webhook received but charge is not yet verified.',
                reference
            });

            // Non-verified events are acknowledged.
            // Reconciliation will check pending transactions.

            return reply.code(200).send({
                received: true,
                pendingVerification: true
            });
        }

        if (verification.status === TX_STATUS.FAILED) {
            await failTransactionStrictly(
                transaction._id,
                'Flutterwave confirmed payment failure.',
                request,
                'Flutterwave webhook'
            );

            return reply.code(200).send({
                received: true,
                paymentStatus: TX_STATUS.FAILED
            });
        }

        if (verification.status !== TX_STATUS.SUCCESS) {
            return reply.code(200).send({
                received: true,
                paymentStatus: TX_STATUS.PENDING
            });
        }

        const result = await creditVerifiedFunding(
            transaction._id,
            request,
            'Flutterwave webhook'
        );

        return reply.code(200).send({
            received: true,
            credited: result.credited,
            alreadyProcessed: result.alreadyProcessed
        });

    } catch (error) {
        logger.error({
            message: 'Flutterwave webhook processing failed',
            error: error.message
        });

        // A server error allows the provider to retry delivery.
        return reply.code(500).send({
            success: false,
            message: 'Webhook processing failed.'
        });
    }
}


// ============================================================
// 10. LEGACY ROUTE COMPATIBILITY
//
// These functions were placeholders in the supplied file.
// They are deliberately not represented as working features.
// ============================================================

function unavailableFeature(name) {
    return async function (request, reply) {
        return reply.code(501).send({
            success: false,
            message: `${name} is not implemented in this wallet controller.`
        });
    };
}

const fundManualWallet =
    unavailableFeature('Manual wallet funding');

const adminApproveManualFunding =
    unavailableFeature('Manual funding approval');

const adminRejectManualFunding =
    unavailableFeature('Manual funding rejection');

const withdraw =
    unavailableFeature('Withdrawals');

const transfer =
    unavailableFeature('Wallet transfers');

const setPin =
    unavailableFeature('Transaction PIN management');

const resolveBankAccount =
    unavailableFeature('Bank account resolution');


// ============================================================
// 11. HEALTH CHECK
// ============================================================

async function healthCheck(request, reply) {
    try {
        return reply.send({
            success: true,
            status: 'Active',
            database:
                mongoose.connection.readyState === 1
                    ? 'OK'
                    : 'DOWN',
            redis:
                redisClient?.status === 'ready'
                    ? 'OK'
                    : 'UNAVAILABLE',
            flutterwave:
                process.env.FLW_CLIENT_ID &&
                process.env.FLW_CLIENT_SECRET
                    ? 'CONFIGURED'
                    : 'NOT_CONFIGURED',
            timestamp: new Date()
        });

    } catch (error) {
        return reply.code(500).send({
            success: false,
            message: 'Health check failed.'
        });
    }
}


// ============================================================
// 12. EXPORTS
// ============================================================

module.exports = {
    getWallet,
    fundWallet,
    verifyFunding,

    fundManualWallet,
    adminApproveManualFunding,
    adminRejectManualFunding,

    withdraw,
    transfer,
    setPin,

    resolveBankAccount,
    handleFlutterwaveWebhook,
    healthCheck
};
