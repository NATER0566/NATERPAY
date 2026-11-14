'use strict';

const assert = require('node:assert/strict');

process.env.MONGODB_URI = 'mongodb://127.0.0.1/naterpay-test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.FLUTTERWAVE_SECRET_KEY = 'test-secret';
process.env.FLUTTERWAVE_SECRET_HASH = 'test-hash';

const axiosPath = require.resolve('axios');
const calls = [];
require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: async (config) => {
    calls.push(config);
    if (config.url.includes('/charges?type=qr')) {
      return {
        data: {
          status: 'success',
          data: {
            id: 'qr-123',
            tx_ref: 'NQR-123',
            qr_code: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        }
      };
    }
    return {
      data: {
        status: 'success',
        data: {
          id: 'provider-123',
          tx_ref: 'NQR-123',
          amount: 100,
          currency: 'NGN',
          status: 'successful'
        }
      }
    };
  }
};

const flutterwave = require('../services/flutterwave');

(async () => {
  const initialized = await flutterwave.initializePayment({
    amount: 100,
    reference: 'NQR-123',
    method: 'qr',
    customer: { email: 'buyer@example.com' }
  });
  assert.equal(initialized.qrCode, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  assert.match(calls[0].url, /\/v3\/charges\?type=qr$/);
  assert.deepEqual(calls[0].data, {
    amount: 100,
    email: 'buyer@example.com',
    tx_ref: 'NQR-123',
    currency: 'NGN',
    is_nqr: 1
  });

  const transaction = {
    providerReference: 'NQR-123',
    amount: 100,
    currency: 'NGN',
    metadata: new Map()
  };
  const verified = await flutterwave.verifyTransaction(transaction);
  assert.equal(verified.verified, true);
  assert.equal(verified.status, 'success');
  assert.match(calls[1].url, /\/transactions\/verify_by_reference\?tx_ref=NQR-123$/);

  const mismatch = await flutterwave.verifyTransaction({ ...transaction, amount: 101 });
  assert.equal(mismatch.status, 'pending');
  const missing = await flutterwave.verifyTransaction({ ...transaction, providerReference: 'missing' });
  assert.equal(missing.status, 'pending');
  assert.equal(flutterwave.verifyWebhookSignature(Buffer.from('{}'), 'test-hash'), true);
  assert.equal(flutterwave.verifyWebhookSignature(Buffer.from('{}'), 'wrong'), false);

  console.log('Payment service tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
