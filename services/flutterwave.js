'use strict';

const axios = require('axios');
const crypto = require('crypto');

const config = require('../config');

const FLW_CONFIG = config.payment?.flutterwave || {};
const BASE_URL = FLW_CONFIG.baseUrl || 'https://api.flutterwave.com/v3';
const SECRET_KEY = FLW_CONFIG.secretKey || process.env.FLUTTERWAVE_SECRET_KEY;
const SECRET_HASH = FLW_CONFIG.secretHash || process.env.FLUTTERWAVE_SECRET_HASH;
const REQUEST_TIMEOUT = 30000;

class FlutterwaveError extends Error {
  constructor(message, statusCode = 502, details = null) {
    super(message);
    this.name = 'FlutterwaveError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function requireCredentials() {
  if (!SECRET_KEY) {
    throw new FlutterwaveError(
      'Flutterwave secret key is not configured.',
      500
    );
  }
}

function createRequestId() {
  return crypto.randomUUID();
}

function safeErrorMessage(error) {
  const responseMessage = error?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage) {
    return responseMessage.slice(0, 300);
  }
  if (error?.code === 'ECONNABORTED') {
    return 'Flutterwave request timed out.';
  }
  return 'Flutterwave service request failed.';
}

async function request(method, path, options = {}) {
  const { data, params, idempotencyKey, traceId } = options;

  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('://')
  ) {
    throw new FlutterwaveError('Invalid Flutterwave API path.', 400);
  }

  requireCredentials();
  const headers = {
    Authorization: `Bearer ${SECRET_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Trace-Id': traceId || createRequestId()
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  try {
    const response = await axios({
      method,
      url: `${BASE_URL}${path}`,
      headers,
      data,
      params,
      timeout: REQUEST_TIMEOUT
    });
    return response.data;
  } catch (error) {
    throw new FlutterwaveError(
      safeErrorMessage(error),
      error?.response?.status || 502,
      error?.response?.data || null
    );
  }
}

function paymentOptions(method) {
  const options = {
    card: 'card',
    transfer: 'banktransfer',
    ussd: 'ussd',
    opay: 'opay'
  };
  return options[method] || null;
}

async function initializePayment({
  amount,
  currency = 'NGN',
  reference,
  customer,
  redirectUrl,
  method,
  idempotencyKey,
  customizations
}) {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new FlutterwaveError('A positive payment amount is required.', 400);
  }
  if (!reference || typeof reference !== 'string') {
    throw new FlutterwaveError('A payment reference is required.', 400);
  }
  if (!customer?.email || typeof customer.email !== 'string') {
    throw new FlutterwaveError('A valid customer email is required.', 400);
  }

  const selectedMethod = paymentOptions(method);
  if (!selectedMethod) {
    throw new FlutterwaveError('Unsupported Flutterwave payment method.', 400);
  }

  const data = {
    tx_ref: reference,
    amount: Number(amount),
    currency,
    redirect_url: redirectUrl,
    payment_options: selectedMethod,
    customer: {
      email: customer.email,
      name: customer.name || customer.email,
      phonenumber: customer.phonenumber || customer.phoneNumber || ''
    },
    customizations: customizations || {
      title: 'NaterPay - Fund Wallet',
      description: 'NaterPay Wallet Funding | Pay to NaterPay - Secure Payment by Flutterwave',
      logo: 'https://your-domain/logo.png'
    },
    meta: {
      userId: customer.userId || null,
      platform: 'NaterPay',
      merchant: 'NaterPay'
    }
  };

  const response = await request('POST', '/payments', {
    data,
    idempotencyKey: idempotencyKey || reference
  });

  const payment = {
    link: response?.data?.link || null,
    tx_ref: response?.data?.tx_ref || reference
  };
  // Keep the provider payload available to the route logger without exposing
  // it as part of the public initialization contract.
  Object.defineProperty(payment, 'rawResponse', {
    value: response,
    enumerable: false
  });
  return payment;
}

function transactionIdFrom(transaction) {
  if (!transaction) return null;
  const response = transaction.providerResponse;
  const responseData = response?.data?.data || response?.data || response;
  const metadata = transaction.metadata;
  const storedId = typeof metadata?.get === 'function'
    ? metadata.get('flutterwaveTransactionId')
    : metadata?.flutterwaveTransactionId;
  return responseData?.id || storedId || null;
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['successful', 'success', 'succeeded'].includes(value)) return 'success';
  if (['cancelled', 'canceled'].includes(value)) return 'cancelled';
  if (['failed', 'declined'].includes(value)) return 'failed';
  return 'pending';
}

function decimalEquals(first, second) {
  const a = Number(first);
  const b = Number(second);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
}

async function verifyPayment(transactionId) {
  if (!transactionId) {
    throw new FlutterwaveError('A Flutterwave transaction ID is required.', 400);
  }
  return request(
    'GET',
    `/transactions/${encodeURIComponent(String(transactionId))}/verify`
  );
}

async function findPaymentsByReference(reference) {
  if (!reference) {
    throw new FlutterwaveError('A Flutterwave transaction reference is required.', 400);
  }
  return request('GET', '/transactions', { params: { tx_ref: reference } });
}

async function verifyTransaction(transaction) {
  if (!transaction) {
    return { verified: false, status: 'pending', reason: 'Transaction record is missing.' };
  }

  let response;
  try {
    const transactionId = transactionIdFrom(transaction);
    response = transactionId
      ? await verifyPayment(transactionId)
      : await findPaymentsByReference(transaction.providerReference);
  } catch (error) {
    return { verified: false, status: 'pending', reason: error.message, providerError: true };
  }

  const responseData = response?.data;
  const payment = Array.isArray(responseData)
    ? responseData.find(item => String(item?.tx_ref || '') === String(transaction.providerReference))
    : responseData;
  if (!payment) {
    return {
      verified: false,
      status: 'failed',
      reason: 'Flutterwave did not find this transaction.'
    };
  }

  if (String(payment.tx_ref || '') !== String(transaction.providerReference || '')) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Transaction reference does not match the local transaction.'
    };
  }
  const expectedCurrency = typeof transaction.metadata?.get === 'function'
    ? transaction.metadata.get('currency')
    : transaction.metadata?.currency;
  if (String(payment.currency || '').toUpperCase() !== String(transaction.currency || expectedCurrency || 'NGN').toUpperCase()) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Transaction currency does not match the local transaction.'
    };
  }
  if (!decimalEquals(payment.amount, transaction.amount)) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Transaction amount does not match the local transaction.'
    };
  }

  return {
    verified: true,
    status: normalizeStatus(payment.status),
    data: payment
  };
}

function verifyWebhookSignature(rawBody, signature) {
  if (!SECRET_HASH || !rawBody || !signature) return false;
  try {
    const expected = String(SECRET_HASH);
    const receivedBuffer = Buffer.from(String(signature), 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return receivedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

module.exports = {
  BASE_URL,
  FlutterwaveError,
  request,
  initializePayment,
  verifyPayment,
  findPaymentsByReference,
  verifyTransaction,
  verifyWebhookSignature,
  normalizeStatus
};
