const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateTransactionReference, generateIdempotencyKey } = require('../utils/auth');
const config = require('../config');
const axios = require('axios');

/**
 * Get VTU rates
 */
async function getRates(request, reply) {
  try {
    const CMS = require('../models/CMS');
    const cms = await CMS.getHomepageData();
    reply.send({ success: true, rates: cms?.homepage?.rates || { mtn: 215, airtel: 190, glo: 220, nineMobile: 180 } });
  } catch (error) {
    console.error('Get rates error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch rates' });
  }
}

/**
 * NEW: Fetch dynamic variations (plans/packages) from VTpass
 */
async function getVariations(request, reply) {
  try {
    const { serviceID } = request.query;
    if (!serviceID) return reply.status(400).send({ success: false, message: 'Service ID is required' });

    const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
    const response = await axios.get(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      headers: {
        'api-key': process.env.VTPASS_API_KEY,
        'public-key': process.env.VTPASS_PUBLIC_KEY
      }
    });

    // Handle variation data structures
    const variations = response.data.content?.varations || response.data.content?.variations || [];
    reply.send({ success: true, variations });
  } catch (error) {
    console.error('VTpass Fetch Error:', error.message);
    reply.status(500).send({ success: false, message: 'Failed to fetch service plans' });
  }
}

/**
 * Buy airtime, data, electricity, cable (Your existing logic remains unchanged)
 * ... (Keep your existing buyAirtime, buyData, buyElectricity, buyCable functions here) ...
 */

// [Include your existing buyAirtime, buyData, buyElectricity, and buyCable functions here]

// ------------------------------------------------------------------
// REAL VTPASS INTEGRATION CORE
// ------------------------------------------------------------------
async function processVTURequest(type, data) {
  const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
  const headers = {
    'api-key': process.env.VTPASS_API_KEY,
    'secret-key': process.env.VTPASS_SECRET_KEY,
    'public-key': process.env.VTPASS_PUBLIC_KEY,
    'Content-Type': 'application/json'
  };

  let payload = {
    request_id: generateTransactionReference(),
    amount: data.amount,
    phone: data.phone || data.meterNumber || data.smartcardNumber
  };

  if (type === 'airtime') payload.serviceID = data.network; 
  else if (type === 'data') {
    payload.serviceID = data.network;
    payload.variation_code = data.plan; 
  } else if (type === 'electricity') {
    payload.serviceID = data.disco;
    payload.billersCode = data.meterNumber;
    payload.variation_code = data.meterType; 
  } else if (type === 'cable') {
    payload.serviceID = data.provider;
    payload.billersCode = data.smartcardNumber;
    payload.variation_code = data.package;
  }

  try {
    const response = await axios.post(`${baseUrl}/pay`, payload, { headers });
    if (response.data.code === '000') {
      return {
        reference: response.data.content.transactions.transactionId,
        token: response.data.token || response.data.purchased_code || null,
        status: 'success',
        raw: response.data
      };
    } else {
      throw new Error(response.data.response_description || 'Transaction failed at provider');
    }
  } catch (error) {
    throw new Error(error.response?.data?.response_description || error.message || 'VTpass connection failed');
  }
}

module.exports = {
  getRates,
  buyAirtime,
  buyData,
  buyElectricity,
  buyCable,
  getVariations // Added this
};
