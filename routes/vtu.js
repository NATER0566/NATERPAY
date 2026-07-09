const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { generateTransactionReference, generateIdempotencyKey } = require('../utils/auth');
const config = require('../config');
const axios = require('axios');
const mongoose = require('mongoose'); // Added to safely manage sessions

/**
 * Get VTU rates
 */
async function getRates(request, reply) {
  try {
    const CMS = require('../models/CMS');
    const cms = await CMS.getHomepageData();
    
    reply.send({
      success: true,
      rates: cms?.homepage?.rates || { mtn: 215, airtel: 190, glo: 220, nineMobile: 180 }
    });
  } catch (error) {
    console.error('Get rates error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch rates' });
  }
}

/**
 * Fetch dynamic variations (plans/packages) from VTpass
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

    const variations = response.data.content?.varations || response.data.content?.variations || [];
    reply.send({ success: true, variations });
  } catch (error) {
    console.error('VTpass Fetch Error:', error.message);
    reply.status(500).send({ success: false, message: 'Failed to fetch service plans from VTpass' });
  }
}

/**
 * Buy Airtime
 */
async function buyAirtime(request, reply) {
  const session = await mongoose.startSession();
  session.startTransaction();
  let sessionActive = true;

  const safeAbort = async () => {
    if (sessionActive) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();
      sessionActive = false;
    }
  };

  try {
    const { phone, network, amount, pin } = request.body;
    
    if (!phone || !network || !amount || amount < 50) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'Invalid inputs. Minimum amount is ₦50.' });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id }).session(session);
    if (!wallet) { await safeAbort(); return reply.status(404).send({ success: false, message: 'Wallet not found' }); }
    if (wallet.isFrozen) { await safeAbort(); return reply.status(403).send({ success: false, message: 'Wallet is frozen' }); }
    
    if (wallet.pinSet && !(await wallet.verifyPin(pin))) {
      await safeAbort();
      return reply.status(401).send({ success: false, message: 'Invalid PIN' });
    }
    
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    }
    
    const transaction = new Transaction({
      user: request.user._id, type: 'airtime', description: `Airtime recharge for ${phone}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: currentAvail.toString(),
      status: 'processing', provider: 'vtpass', idempotencyKey: generateIdempotencyKey(),
      serviceDetails: { phone, network, amount }, ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    let providerResponse;
    try {
      providerResponse = await processVTURequest('airtime', { phone, network, amount });
    } catch (vtuError) {
      await safeAbort();
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save(); // Save outside of session to persist failure log
      return reply.status(500).send({ success: false, message: 'VTU provider error', error: vtuError.message });
    }
    
    // Process Success securely
    const currentLedger = parseFloat(wallet.balance?.toString() || '0');
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (currentLedger - amount).toString();
    await wallet.save({ session });

    transaction.providerReference = providerResponse.reference;
    transaction.status = 'success';
    transaction.providerResponse = providerResponse.raw;
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    sessionActive = false;
    
    await AuditLog.logAction({ user: request.user._id, action: 'transaction_create', description: `Airtime: ₦${amount} to ${phone}`, ipAddress: request.ip });
    await Notification.create({ user: request.user._id, title: 'Airtime Purchase Successful', message: `₦${amount.toLocaleString()} airtime sent to ${phone}`, type: 'transaction', priority: 'medium' });
    
    reply.send({ success: true, message: 'Airtime purchase successful', transaction });
    
  } catch (error) {
    await safeAbort();
    console.error('Buy airtime error:', error);
    reply.status(500).send({ success: false, message: 'Failed to purchase airtime' });
  }
}

/**
 * Buy Data
 */
async function buyData(request, reply) {
  const session = await mongoose.startSession();
  session.startTransaction();
  let sessionActive = true;

  const safeAbort = async () => {
    if (sessionActive) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();
      sessionActive = false;
    }
  };

  try {
    const { phone, network, plan, amount, pin } = request.body;
    
    if (!phone || !network || !plan || !amount) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'All fields are required' });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id }).session(session);
    if (!wallet) { await safeAbort(); return reply.status(404).send({ success: false, message: 'Wallet not found' }); }
    if (wallet.isFrozen) { await safeAbort(); return reply.status(403).send({ success: false, message: 'Wallet is frozen' }); }
    
    if (wallet.pinSet && !(await wallet.verifyPin(pin))) {
      await safeAbort();
      return reply.status(401).send({ success: false, message: 'Invalid PIN' });
    }
    
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    }
    
    const transaction = new Transaction({
      user: request.user._id, type: 'data', description: `${plan} data for ${phone}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: currentAvail.toString(),
      status: 'processing', provider: 'vtpass', idempotencyKey: generateIdempotencyKey(),
      serviceDetails: { phone, network, plan, amount }, ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    let providerResponse;
    try {
      providerResponse = await processVTURequest('data', { phone, network, plan, amount });
    } catch (vtuError) {
      await safeAbort();
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save(); 
      return reply.status(500).send({ success: false, message: 'VTU provider error', error: vtuError.message });
    }
    
    const currentLedger = parseFloat(wallet.balance?.toString() || '0');
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (currentLedger - amount).toString();
    await wallet.save({ session });
      
    transaction.providerReference = providerResponse.reference;
    transaction.status = 'success';
    transaction.providerResponse = providerResponse.raw;
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    sessionActive = false;
    
    await AuditLog.logAction({ user: request.user._id, action: 'transaction_create', description: `Data: ${plan} for ${phone}`, ipAddress: request.ip });
    await Notification.create({ user: request.user._id, title: 'Data Purchase Successful', message: `${plan} data sent to ${phone}`, type: 'transaction', priority: 'medium' });
    
    reply.send({ success: true, message: 'Data purchase successful', transaction });
    
  } catch (error) {
    await safeAbort();
    console.error('Buy data error:', error);
    reply.status(500).send({ success: false, message: 'Failed to purchase data' });
  }
}

/**
 * Buy Electricity
 */
async function buyElectricity(request, reply) {
  const session = await mongoose.startSession();
  session.startTransaction();
  let sessionActive = true;

  const safeAbort = async () => {
    if (sessionActive) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();
      sessionActive = false;
    }
  };

  try {
    const { meterNumber, disco, amount, meterType, pin } = request.body;
    
    if (!meterNumber || !disco || !amount || !meterType) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'All fields are required' });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id }).session(session);
    if (!wallet) { await safeAbort(); return reply.status(404).send({ success: false, message: 'Wallet not found' }); }
    if (wallet.isFrozen) { await safeAbort(); return reply.status(403).send({ success: false, message: 'Wallet is frozen' }); }
    
    if (wallet.pinSet && !(await wallet.verifyPin(pin))) {
      await safeAbort();
      return reply.status(401).send({ success: false, message: 'Invalid PIN' });
    }
    
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    }
    
    const transaction = new Transaction({
      user: request.user._id, type: 'electricity', description: `Power bill for meter ${meterNumber}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: currentAvail.toString(),
      status: 'processing', provider: 'vtpass', idempotencyKey: generateIdempotencyKey(),
      serviceDetails: { meterNumber, disco, amount, meterType }, ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    let providerResponse;
    try {
      providerResponse = await processVTURequest('electricity', { meterNumber, disco, amount, meterType });
    } catch (vtuError) {
      await safeAbort();
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save();
      return reply.status(500).send({ success: false, message: 'VTU provider error', error: vtuError.message });
    }
    
    const currentLedger = parseFloat(wallet.balance?.toString() || '0');
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (currentLedger - amount).toString();
    await wallet.save({ session });
      
    transaction.providerReference = providerResponse.reference;
    transaction.status = 'success';
    transaction.providerResponse = providerResponse.raw;
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    sessionActive = false;
    
    await AuditLog.logAction({ user: request.user._id, action: 'transaction_create', description: `Electricity: ₦${amount} for ${meterNumber}`, ipAddress: request.ip });
    await Notification.create({ user: request.user._id, title: 'Power Payment Successful', message: `₦${amount.toLocaleString()} paid for meter ${meterNumber}`, type: 'transaction', priority: 'medium' });
    
    reply.send({ success: true, message: 'Electricity payment successful', transaction, token: providerResponse.token });
    
  } catch (error) {
    await safeAbort();
    console.error('Buy electricity error:', error);
    reply.status(500).send({ success: false, message: 'Failed to process electricity payment' });
  }
}

/**
 * Buy Cable TV
 */
async function buyCable(request, reply) {
  const session = await mongoose.startSession();
  session.startTransaction();
  let sessionActive = true;

  const safeAbort = async () => {
    if (sessionActive) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();
      sessionActive = false;
    }
  };

  try {
    const { smartcardNumber, provider, package: pkg, amount, pin } = request.body;
    
    if (!smartcardNumber || !provider || !pkg || !amount) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'All fields are required' });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id }).session(session);
    if (!wallet) { await safeAbort(); return reply.status(404).send({ success: false, message: 'Wallet not found' }); }
    if (wallet.isFrozen) { await safeAbort(); return reply.status(403).send({ success: false, message: 'Wallet is frozen' }); }
    
    if (wallet.pinSet && !(await wallet.verifyPin(pin))) {
      await safeAbort();
      return reply.status(401).send({ success: false, message: 'Invalid PIN' });
    }
    
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) {
      await safeAbort();
      return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    }
    
    const transaction = new Transaction({
      user: request.user._id, type: 'cable', description: `${provider} ${pkg} subscription`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: currentAvail.toString(),
      status: 'processing', provider: 'vtpass', idempotencyKey: generateIdempotencyKey(),
      serviceDetails: { smartcardNumber, provider, package: pkg, amount }, ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    
    await transaction.save({ session });
    
    let providerResponse;
    try {
      providerResponse = await processVTURequest('cable', { smartcardNumber, provider, package: pkg, amount });
    } catch (vtuError) {
      await safeAbort();
      transaction.status = 'failed';
      transaction.providerResponse = { error: vtuError.message };
      await transaction.save();
      return reply.status(500).send({ success: false, message: 'VTU provider error', error: vtuError.message });
    }
    
    const currentLedger = parseFloat(wallet.balance?.toString() || '0');
    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (currentLedger - amount).toString();
    await wallet.save({ session });
      
    transaction.providerReference = providerResponse.reference;
    transaction.status = 'success';
    transaction.providerResponse = providerResponse.raw;
    transaction.balanceAfter = wallet.availableBalance.toString();
    await transaction.save({ session });
    
    await session.commitTransaction();
    session.endSession();
    sessionActive = false;
    
    await AuditLog.logAction({ user: request.user._id, action: 'transaction_create', description: `Cable sub: ${provider} ${pkg}`, ipAddress: request.ip });
    await Notification.create({ user: request.user._id, title: 'Cable Subscription Successful', message: `${provider} ${pkg} activated`, type: 'transaction', priority: 'medium' });
    
    reply.send({ success: true, message: 'Cable subscription successful', transaction });
    
  } catch (error) {
    await safeAbort();
    console.error('Buy cable error:', error);
    reply.status(500).send({ success: false, message: 'Failed to process cable subscription' });
  }
}

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

  if (type === 'airtime') {
    payload.serviceID = data.network; 
  } else if (type === 'data') {
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
  getVariations,
  buyAirtime,
  buyData,
  buyElectricity,
  buyCable
};
