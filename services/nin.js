'use strict';

const axios = require('axios');
const config = require('../config');

const ninConfig = config.kyc?.nin || {};
const REQUEST_TIMEOUT = 30000;

class NINVerificationError extends Error {
  constructor(message, statusCode = 502, details = null) {
    super(message);
    this.name = 'NINVerificationError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function providerConfigured() {
  return String(ninConfig.provider || 'dojah').toLowerCase() === 'dojah' &&
    Boolean(ninConfig.dojahApiKey && ninConfig.dojahAppId);
}

async function verifyNIN(nin) {
  if (!/^\d{11}$/.test(String(nin || ''))) {
    throw new NINVerificationError('NIN verification failed - check your NIN', 400);
  }
  if (!providerConfigured()) {
    throw new NINVerificationError(
      'NIN verification provider is not configured yet - please add NIN provider key in Render Environment, KYC cannot be fully verified without it',
      503
    );
  }

  try {
    const response = await axios.get(`${ninConfig.dojahBaseUrl}/api/v1/kyc/nin`, {
      params: { nin: String(nin) },
      headers: {
        Accept: 'application/json',
        AppId: ninConfig.dojahAppId,
        Authorization: ninConfig.dojahApiKey
      },
      timeout: REQUEST_TIMEOUT
    });
    const entity = response.data?.entity || response.data?.data;
    if (!entity || response.data?.error || response.data?.success === false) {
      throw new NINVerificationError('NIN verification failed - check your NIN', 400, response.data);
    }
    return entity;
  } catch (error) {
    if (error instanceof NINVerificationError) throw error;
    throw new NINVerificationError('NIN verification failed - check your NIN', error.response?.status || 502, error.response?.data);
  }
}

module.exports = { NINVerificationError, verifyNIN };
