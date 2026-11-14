
'use strict';

const axios = require('axios');
const crypto = require('crypto');

const config = require('../config');

const FLW_CONFIG = config.payment?.flutterwave || {};

const BASE_URL =
  FLW_CONFIG.baseUrl ||
  'https://f4bexperience.flutterwave.com';

const SECRET_KEY =
  FLW_CONFIG.secretKey || process.env.FLUTTERWAVE_SECRET_KEY;
const PUBLIC_KEY =
  FLW_CONFIG.publicKey || process.env.FLUTTERWAVE_PUBLIC_KEY;

const SECRET_HASH =
  FLW_CONFIG.secretHash || process.env.FLUTTERWAVE_SECRET_HASH;

const REQUEST_TIMEOUT = 30000;
const TOKEN_REFRESH_BUFFER = 30000;

let cachedToken = null;
let tokenExpiresAt = 0;

class FlutterwaveError extends Error {
  constructor(message, statusCode = 502, details = null) {
    super(message);
    this.name = 'FlutterwaveError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function requireCredentials() {
  if (!SECRET_KEY || !PUBLIC_KEY) {
    throw new FlutterwaveError(
      'Flutterwave API credentials are not configured.',
      500
    );
  }
}

function createRequestId() {
  return crypto.randomUUID();
}

function safeErrorMessage(error) {
  const responseMessage =
    error?.response?.data?.message ||
    error?.response?.data?.error_description;

  if (responseMessage && typeof responseMessage === 'string') {
    return responseMessage.slice(0, 300);
  }

  if (error?.code === 'ECONNABORTED') {
    return 'Flutterwave request timed out.';
  }

  return 'Flutterwave service request failed.';
}

/**
 * Obtain and cache the Flutterwave bearer credential.
 */
async function getAccessToken(forceRefresh = false) {
  requireCredentials();

  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() < tokenExpiresAt - TOKEN_REFRESH_BUFFER
  ) {
    return cachedToken;
  }

  // Flutterwave API requests authenticate directly with the secret key.
  // Keep the existing cache contract so callers do not need to change.
  cachedToken = SECRET_KEY;
  tokenExpiresAt = Date.now() + 3600000;
  return cachedToken;
}

/**
 * Make an authenticated Flutterwave V4 API request.
 *
 * The caller supplies a stable idempotency key for operations
 * that create charges, customers, or virtual accounts.
 */
async function request(method, path, options = {}) {
  const {
    data,
    params,
    idempotencyKey,
    traceId,
    retryUnauthorized = true
  } = options;

  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//')
  ) {
    throw new FlutterwaveError('Invalid Flutterwave API path.', 400);
  }

  const token = await getAccessToken();

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Trace-Id': traceId || createRequestId()
  };

  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

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
    if (
      error?.response?.status === 401 &&
      retryUnauthorized
    ) {
      cachedToken = null;
      tokenExpiresAt = 0;

      await getAccessToken(true);

      return request(method, path, {
        ...options,
        retryUnauthorized: false
      });
    }

    const statusCode = error?.response?.status || 502;

    throw new FlutterwaveError(
      safeErrorMessage(error),
      statusCode,
      error?.response?.data || null
    );
  }
}

/**
 * Create a Flutterwave customer.
 *
 * Supply genuine customer information from your database.
 * Never invent identity or KYC information.
 */
async function createCustomer(customer, idempotencyKey) {
  if (!customer || typeof customer !== 'object') {
    throw new FlutterwaveError('Customer information is required.', 400);
  }

  if (!customer.email || typeof customer.email !== 'string') {
    throw new FlutterwaveError('A valid customer email is required.', 400);
  }

  if (!idempotencyKey) {
    throw new FlutterwaveError(
      'A customer creation idempotency key is required.',
      400
    );
  }

  return request('POST', '/customers', {
    data: customer,
    idempotencyKey
  });
}

/**
 * Create a V4 virtual account.
 *
 * customerId must be an actual Flutterwave customer ID.
 * BVN/NIN are optional fields and are never fabricated here.
 */
async function createVirtualAccount({
  reference,
  customerId,
  currency = 'NGN',
  accountType = 'static',
  amount = 0,
  bvn,
  nin,
  narration,
  idempotencyKey
}) {
  if (!reference || !/^[a-zA-Z0-9-]{6,42}$/.test(reference)) {
    throw new FlutterwaveError(
      'Virtual account reference must contain 6–42 valid characters.',
      400
    );
  }

  if (!customerId) {
    throw new FlutterwaveError(
      'A real Flutterwave customer ID is required.',
      400
    );
  }

  if (!['NGN', 'GHS', 'EGP', 'KES', 'MAD', 'ZAR'].includes(currency)) {
    throw new FlutterwaveError('Unsupported virtual account currency.', 400);
  }

  if (!['static', 'dynamic'].includes(accountType)) {
    throw new FlutterwaveError('Invalid virtual account type.', 400);
  }

  if (
    accountType === 'static' &&
    Number(amount) !== 0
  ) {
    throw new FlutterwaveError(
      'A static virtual account must use amount 0.',
      400
    );
  }

  if (
    accountType === 'dynamic' &&
    (!Number.isFinite(Number(amount)) || Number(amount) <= 0)
  ) {
    throw new FlutterwaveError(
      'A dynamic virtual account requires a positive amount.',
      400
    );
  }

  if (!idempotencyKey) {
    throw new FlutterwaveError(
      'A virtual account idempotency key is required.',
      400
    );
  }

  const data = {
    reference,
    customer_id: customerId,
    currency,
    account_type: accountType,
    amount: Number(amount)
  };

  if (bvn) data.bvn = bvn;
  if (nin) data.nin = nin;

  if (narration) {
    data.meta = { narration };
  }

  return request('POST', '/virtual-accounts', {
    data,
    idempotencyKey
  });
}

/**
 * Initiate a V4 Orchestration charge.
 *
 * The caller must provide the payment_method object required
 * by the selected Flutterwave payment method.
 *
 * This function does not assume that every payment method
 * supports the same fields.
 */
async function createCharge(payload, idempotencyKey) {
  if (!payload || typeof payload !== 'object') {
    throw new FlutterwaveError('Charge information is required.', 400);
  }

  if (
    !payload.amount ||
    !payload.currency ||
    !payload.reference ||
    !payload.customer ||
    !payload.payment_method
  ) {
    throw new FlutterwaveError(
      'Charge requires amount, currency, reference, customer and payment_method.',
      400
    );
  }

  if (!idempotencyKey) {
    throw new FlutterwaveError(
      'A charge idempotency key is required.',
      400
    );
  }

  return request('POST', '/orchestration/direct-charges', {
    data: payload,
    idempotencyKey
  });
}

/**
 * Retrieve a V4 charge using its Flutterwave charge ID.
 */
async function getCharge(chargeId) {
  if (
    !chargeId ||
    typeof chargeId !== 'string' ||
    !chargeId.startsWith('chg_')
  ) {
    throw new FlutterwaveError(
      'A valid Flutterwave charge ID is required.',
      400
    );
  }

  return request(
    'GET',
    `/charges/${encodeURIComponent(chargeId)}`
  );
}

function getTransactionChargeId(transaction) {
  if (!transaction) return null;

  const response = transaction.providerResponse;

  if (response && typeof response === 'object') {
    const responseData = response.data || response;

    if (responseData.id && String(responseData.id).startsWith('chg_')) {
      return String(responseData.id);
    }
  }

  const metadata = transaction.metadata;

  if (metadata) {
    const metadataChargeId =
      typeof metadata.get === 'function'
        ? metadata.get('flutterwaveChargeId')
        : metadata.flutterwaveChargeId;

    if (
      metadataChargeId &&
      String(metadataChargeId).startsWith('chg_')
    ) {
      return String(metadataChargeId);
    }
  }

  return null;
}

function normalizeChargeStatus(status) {
  const value = String(status || '').toLowerCase();

  if (['succeeded', 'successful', 'success'].includes(value)) {
    return 'success';
  }

  if (['failed', 'declined', 'voided'].includes(value)) {
    return 'failed';
  }

  return 'pending';
}

function decimalEquals(first, second) {
  const a = Number(first);
  const b = Number(second);

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }

  return Math.abs(a - b) < 0.000001;
}

/**
 * Reconciliation adapter.
 *
 * Returns:
 * { verified: true, status: 'success'|'failed'|'pending', data }
 *
 * A transaction without a stored Flutterwave charge ID stays
 * pending. This function never credits a wallet.
 */
async function verifyTransaction(transaction) {
  if (!transaction) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Transaction record is missing.'
    };
  }

  const chargeId = getTransactionChargeId(transaction);

  if (!chargeId) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Flutterwave charge ID has not been recorded.'
    };
  }

  let response;

  try {
    response = await getCharge(chargeId);
  } catch (error) {
    return {
      verified: false,
      status: 'pending',
      reason: error.message
    };
  }

  const charge = response?.data || response;

  if (!charge || String(charge.id) !== chargeId) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Flutterwave returned an unexpected charge.'
    };
  }

  const expectedReference = String(
    transaction.providerReference || ''
  );

  const actualReference = String(charge.reference || '');

  if (!expectedReference || actualReference !== expectedReference) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Charge reference does not match the local transaction.'
    };
  }

  const expectedCurrency = String(
    transaction.currency || 'NGN'
  ).toUpperCase();

  const actualCurrency = String(
    charge.currency || ''
  ).toUpperCase();

  if (actualCurrency !== expectedCurrency) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Charge currency does not match the local transaction.'
    };
  }

  if (!decimalEquals(charge.amount, transaction.amount)) {
    return {
      verified: false,
      status: 'pending',
      reason: 'Charge amount does not match the local transaction.'
    };
  }

  return {
    verified: true,
    status: normalizeChargeStatus(charge.status),
    data: charge
  };
}

/**
 * Verify the V4 webhook signature.
 *
 * rawBody must be the original request body as a Buffer
 * or the exact original UTF-8 string.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!SECRET_HASH || !rawBody || !signature) {
    return false;
  }

  try {
    const body = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(String(rawBody), 'utf8');

    const expected = crypto
      .createHmac('sha256', SECRET_HASH)
      .update(body)
      .digest('base64');

    const receivedBuffer = Buffer.from(String(signature), 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    return (
      receivedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    );
  } catch {
    return false;
  }
}

module.exports = {
  FlutterwaveError,
  getAccessToken,
  request,
  createCustomer,
  createVirtualAccount,
  createCharge,
  getCharge,
  verifyTransaction,
  verifyWebhookSignature,
  normalizeChargeStatus
};
