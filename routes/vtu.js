const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const axios = require('axios');
const mongoose = require('mongoose');

// --- HELPER: VTPASS STRICT REQUEST ID FORMATTER ---
function generateVTpassRequestId() {
  // VTpass demands: YYYYMMDDHHII (First 12 must be numeric date/time in Africa/Lagos)
  const d = new Date();
  const lagosTime = new Date(d.getTime() + (1 * 60 * 60 * 1000)); // GMT+1
  
  const year = lagosTime.getUTCFullYear();
  const month = String(lagosTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(lagosTime.getUTCDate()).padStart(2, '0');
  const hour = String(lagosTime.getUTCHours()).padStart(2, '0');
  const minute = String(lagosTime.getUTCMinutes()).padStart(2, '0');
  
  const prefix = `${year}${month}${day}${hour}${minute}`;
  const suffix = Math.random().toString(36).substring(2, 8); // Random string attached at the end
  return prefix + suffix;
}

async function getRates(request, reply) {
  try {
    const CMS = require('../models/CMS');
    const cms = await CMS.getHomepageData();
    reply.send({ success: true, rates: cms?.homepage?.rates || { mtn: 215, airtel: 190, glo: 220, nineMobile: 180 } });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch rates' }); }
}

async function getVariations(request, reply) {
  try {
    const { serviceID } = request.query;
    const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
    const response = await axios.get(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }
    });
    reply.send({ success: true, variations: response.data.content?.varations || response.data.content?.variations || [] });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch service plans' }); }
}

async function buyAirtime(request, reply) {
  try {
    const { phone, network, amount, pin } = request.body;
    if (!phone || !network || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    // Deduct Wallet First
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    // Log Transaction safely
    const transaction = new Transaction({
      user: request.user._id, type: 'airtime', description: `${network.toUpperCase()} Airtime for ${phone}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    // Process VTU
    try {
      const providerResponse = await processVTURequest('airtime', { phone, network, amount });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Airtime purchase successful', transaction });

    } catch (vtuError) {
      // Refund Wallet on VTU Failure
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) {
    console.error('Airtime error:', error);
    reply.status(500).send({ success: false, message: 'System error processing airtime' });
  }
}

async function buyData(request, reply) {
  try {
    const { phone, network, plan, amount, pin } = request.body;
    if (!phone || !network || !amount || !plan) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'data', description: `Data Plan for ${phone}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('data', { phone, network, plan, amount });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Data purchase successful', transaction });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) {
    console.error('Data error:', error);
    reply.status(500).send({ success: false, message: 'System error processing data' });
  }
}

// Electricity and Cable
async function buyElectricity(request, reply) { reply.status(500).send({success:false, message: 'Temporarily offline for safety config.'}); }
async function buyCable(request, reply) { reply.status(500).send({success:false, message: 'Temporarily offline for safety config.'}); }

// ==================================================================
// REAL VTPASS INTEGRATION CORE (STRICT DOCUMENTATION ADHERENCE)
// ==================================================================
async function processVTURequest(type, data) {
  // If no API keys, block the transaction instead of pretending it worked.
  if (!process.env.VTPASS_API_KEY || !process.env.VTPASS_SECRET_KEY) {
      throw new Error("VTpass API Keys are not configured in the server environment (.env).");
  }

  const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
  
  // VTpass Documentation requires api-key and secret-key for POST requests.
  const headers = { 
      'api-key': process.env.VTPASS_API_KEY, 
      'secret-key': process.env.VTPASS_SECRET_KEY, 
      'Content-Type': 'application/json' 
  };

  // Base Payload
  let payload = { 
      request_id: generateVTpassRequestId(), 
      amount: data.amount, 
      phone: data.phone || data.meterNumber || data.smartcardNumber 
  };

  // strict mapping per VTpass docs
  if (type === 'airtime') {
      payload.serviceID = data.network; 
  } else if (type === 'data') { 
      payload.serviceID = data.network; 
      payload.billersCode = data.phone; // VTpass requires billersCode for data
      payload.variation_code = data.plan; 
  }

  try {
    console.log(`[VTPASS] Sending request:`, JSON.stringify(payload));
    
    const response = await axios.post(`${baseUrl}/pay`, payload, { headers });
    
    console.log(`[VTPASS] Response Code:`, response.data.code);
    
    if (response.data.code === '000') {
      return { reference: response.data.content.transactions.transactionId, status: 'success', raw: response.data };
    } else {
      throw new Error(response.data.response_description || 'Transaction failed at provider');
    }
  } catch (error) {
    console.error(`[VTPASS] Crash details:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.response_description || 'VTpass connection failed');
  }
}

module.exports = { getRates, getVariations, buyAirtime, buyData, buyElectricity, buyCable };
