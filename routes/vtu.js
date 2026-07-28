const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const User = require('../models/User'); 
const bcrypt = require('bcryptjs'); 
const axios = require('axios');

// [1] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let AuditLog;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}

// [2] STRICT MONEY PRECISION HELPER
const sanitizeAmount = (amount) => {
    const num = Number(parseFloat(amount).toFixed(2));
    if (isNaN(num)) throw new Error('Invalid monetary amount.');
    return num;
};

// [3] IMMUTABLE AUDIT LOGGING ENGINE
async function createAuditLog(params, session = null) {
    if (!AuditLog) return;
    try {
        const log = new AuditLog({
            user: params.user, transactionId: params.transactionId, transactionReference: params.reference,
            amount: params.amount, type: params.type, previousBalance: String(params.previousBalance),
            newBalance: String(params.newBalance), ipAddress: params.ipAddress, userAgent: params.userAgent,
            status: params.status, source: params.source
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

const variationsCache = {};
const CACHE_TIME = 1000 * 60 * 60 * 24; 

function generateVTpassRequestId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  return dateStr + randomSuffix;
}

// =====================================================================
// NATER-PAY ENTERPRISE DISCOUNT ENGINE
// =====================================================================
function applyEnterpriseDiscount(originalAmount, serviceType, userRole) {
    const role = (userRole || 'user').toLowerCase();

    const commissionRates = { 
        airtime: 0.03, data: 0.03, cable: 0.015, electricity: 0.015, 
        betting: 0.01, insurance: 0.015, sms: 0.01, education: 0        
    };

    const rate = commissionRates[serviceType] || 0;
    const platformCommission = originalAmount * rate;
    
    if (platformCommission <= 0) return originalAmount;

    let discount = 0;

    if (role === 'vip') discount = platformCommission * 0.35; 
    else if (role === 'reseller' || role === 'agent') discount = platformCommission * 0.20; 
    else discount = platformCommission * 0.05; 

    const discountedPrice = originalAmount - discount;
    const actualCostPrice = originalAmount - platformCommission;
    
    if (discountedPrice < actualCostPrice) return actualCostPrice; 
    return parseFloat(discountedPrice.toFixed(2));
}

// =====================================================================
// SECURE TRANSACTION PIN VALIDATOR
// =====================================================================
async function validateTransactionPin(userId, inputPin) {
    if (!inputPin || inputPin.length !== 4) return { isValid: false, message: 'A valid 4-digit PIN is required.' };
    const wallet = await Wallet.findOne({ user: userId }).select('+pin');
    const user = await User.findById(userId).select('+pin +transactionPin +withdrawalPin');
    if (!wallet || !user) return { isValid: false, message: 'Wallet architecture not found.' };
    
    const actualPinHash = wallet.pin || user.pin || user.transactionPin || user.withdrawalPin;
    if (!actualPinHash) return { isValid: false, message: 'Security Alert: You have not set up a Transaction PIN yet. Please configure it in your Profile settings.' };
    
    const isMatch = await bcrypt.compare(String(inputPin), actualPinHash);
    if (!isMatch) return { isValid: false, message: 'Incorrect 4-Digit PIN. Transaction aborted.' };
    return { isValid: true };
}

// =====================================================================
// ENTERPRISE REFERRAL & SPEND TRACKING ENGINE (ATOMIC)
// =====================================================================
async function registerSuccessfulSpend(userId, amountSpent, io) {
    try {
        const spendAmt = sanitizeAmount(amountSpent);
        const user = await User.findByIdAndUpdate(userId, { $inc: { cumulativeSpend: spendAmt } }, { new: true });
        if (!user) return;

        if (user.referredBy && !user.referralBonusPaid && user.cumulativeSpend >= 5000) {
            const referrer = await User.findOne({ referralCode: user.referredBy });
            
            if (referrer && (referrer.cumulativeSpend || 0) >= 5000) {
                const REWARD_AMOUNT = 50; 

                // Atomic Referrer Reward
                const referrerWallet = await Wallet.findOneAndUpdate(
                    { user: referrer._id }, { $inc: { availableBalance: REWARD_AMOUNT, balance: REWARD_AMOUNT } }, { new: true }
                );

                if (referrerWallet) {
                    await User.updateOne({ _id: referrer._id }, { $inc: { referralCount: 1, referralBonus: REWARD_AMOUNT } });
                    await Transaction.create({
                        user: referrer._id, type: 'referral_bonus', description: `Referral Milestone unlocked for ${user.name}`,
                        amount: REWARD_AMOUNT, fee: 0, balanceBefore: String(sanitizeAmount(referrerWallet.availableBalance) - REWARD_AMOUNT), balanceAfter: String(referrerWallet.availableBalance),
                        status: 'success', provider: 'internal', reference: `REF-${Date.now()}-A`
                    });
                    if (io) {
                        io.to(`user:${referrer._id}`).emit('wallet:update', { balance: String(referrerWallet.availableBalance) });
                        io.to(`user:${referrer._id}`).emit('notification', { type: 'success', title: 'Referral Bonus Unlocked!', message: `You received ₦${REWARD_AMOUNT} because ${user.name} hit the ₦5,000 spend milestone!` });
                    }
                }

                // Atomic User Reward
                const userWallet = await Wallet.findOneAndUpdate(
                    { user: user._id }, { $inc: { availableBalance: REWARD_AMOUNT, balance: REWARD_AMOUNT } }, { new: true }
                );

                if (userWallet) {
                    await User.updateOne({ _id: user._id }, { $set: { referralBonusPaid: true } });
                    await Transaction.create({
                        user: user._id, type: 'referral_bonus', description: `Welcome Milestone Bonus Unlocked`,
                        amount: REWARD_AMOUNT, fee: 0, balanceBefore: String(sanitizeAmount(userWallet.availableBalance) - REWARD_AMOUNT), balanceAfter: String(userWallet.availableBalance),
                        status: 'success', provider: 'internal', reference: `REF-${Date.now()}-B`
                    });
                    if (io) {
                        io.to(`user:${user._id}`).emit('wallet:update', { balance: String(userWallet.availableBalance) });
                        io.to(`user:${user._id}`).emit('notification', { type: 'success', title: 'Welcome Bonus Unlocked!', message: `You received ₦${REWARD_AMOUNT} for reaching the ₦5,000 spending milestone!` });
                    }
                }
            }
        }
    } catch (error) { logger.error("Tracking Engine Error:", error); }
}

// ==================================================================
// REAL VTPASS INTEGRATION CORE (STRICT DOCUMENTATION COMPLIANCE)
// ==================================================================
async function processVTURequest(type, data) {
  if (!process.env.VTPASS_API_KEY || !process.env.VTPASS_SECRET_KEY) throw new Error("VTpass API Keys are missing.");

  const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
  const isSandbox = baseUrl.includes('sandbox');
  const headers = { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY, 'Content-Type': 'application/json' };

  let payload = { request_id: generateVTpassRequestId(), amount: data.amount };

  if (type === 'airtime') {
      payload.serviceID = data.network; payload.phone = isSandbox ? '08011111111' : data.phone;
  } else if (type === 'data') { 
      payload.serviceID = data.network; payload.variation_code = data.plan; payload.phone = isSandbox ? '08011111111' : data.phone; 
      payload.billersCode = isSandbox ? (data.network === 'spectranet' ? '1212121212' : '08011111111') : data.phone;
  } else if (type === 'electricity') {
      payload.serviceID = (data.disco === 'port-harcourt-electric') ? 'portharcourt-electric' : data.disco;
      payload.variation_code = data.meterType; payload.phone = isSandbox ? '08011111111' : (data.phone || '08011111111');
      if (isSandbox) payload.billersCode = data.meterType === 'prepaid' ? '1111111111111' : '1010101010101';
      else payload.billersCode = data.meterNumber;
  } else if (type === 'cable') {
      payload.serviceID = data.provider; payload.variation_code = data.package; payload.phone = data.phone || '08000000000';
      if (data.provider === 'showmax') payload.billersCode = data.smartcardNumber; 
      else { payload.billersCode = isSandbox ? '1212121212' : data.smartcardNumber; payload.subscription_type = 'change'; }
  } else if (type === 'education') {
      payload.phone = isSandbox ? '08011111111' : (data.phone || '08011111111'); payload.quantity = parseInt(data.quantity) || 1;
      if (data.provider === 'waec' || data.provider === 'waecdirect' || data.provider === 'waec-result') { payload.serviceID = 'waec'; payload.variation_code = 'waecdirect'; } 
      else if (data.provider === 'waec-registration' || data.provider === 'waec-registraion') { payload.serviceID = 'waec-registration'; payload.variation_code = 'waec-registraion'; } 
      else if (data.provider === 'jamb') { payload.serviceID = 'jamb'; payload.variation_code = 'utme-no-mock'; payload.billersCode = isSandbox ? '0123456789' : (data.phone || '08011111111'); } 
      else if (data.provider === 'neco') { payload.serviceID = 'neco'; payload.variation_code = 'neco-biller'; } 
      else { payload.serviceID = data.provider; payload.variation_code = 'default'; }
  } else if (type === 'betting') {
      payload.serviceID = data.provider; payload.phone = data.phone || '08000000000'; payload.billersCode = isSandbox ? '08011111111' : data.customerId;
  } else if (type === 'insurance') {
      payload.serviceID = data.provider; payload.phone = isSandbox ? '08011111111' : data.phone;
  } else if (type === 'sms') {
      payload.serviceID = data.provider || 'bulk-sms'; payload.phone = data.phone;
  } else if (type === 'foreign-airtime') {
      // FIX: Changed product_type_id to 1 (Mobile Top Up / Airtime)
      payload.serviceID = 'foreign-airtime';
      payload.operator_id = data.operator; 
      payload.country_code = data.country;
      payload.product_type_id = '1'; 
      payload.email = data.email || 'user@naterpay.com';
      payload.phone = isSandbox ? '08011111111' : data.phone;
      payload.billersCode = isSandbox ? '08011111111' : data.phone;
      
      // Auto-fetches the required variation_code in the background
      try {
          const varHeaders = { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY };
          const varRes = await axios.get(`${baseUrl}/service-variations?serviceID=foreign-airtime&operator_id=${data.operator}&product_type_id=1`, { headers: varHeaders });
          const variations = varRes.data.content?.varations || varRes.data.content?.variations || [];
          if (variations.length > 0) payload.variation_code = variations[0].variation_code;
          else payload.variation_code = 'foreign-airtime';
      } catch(e) { payload.variation_code = 'foreign-airtime'; }
  }

  try {
    const response = await axios.post(`${baseUrl}/pay`, payload, { headers, timeout: 30000 });
    if (response.data.code === '000') {
      let extractedToken = response.data.purchased_code || response.data.token || response.data.Pin || null;
      if (response.data.cards && Array.isArray(response.data.cards) && response.data.cards.length > 0) extractedToken = `PIN: ${response.data.cards[0].Pin} | Serial: ${response.data.cards[0].Serial}`;
      else if (response.data.tokens && Array.isArray(response.data.tokens) && response.data.tokens.length > 0) extractedToken = `Token: ${response.data.tokens[0]}`;
      else if (response.data.Voucher && Array.isArray(response.data.Voucher) && response.data.Voucher.length > 0) extractedToken = `Voucher: ${response.data.Voucher[0]}`;

      return { reference: response.data.content?.transactions?.transactionId || response.data.content?.transactions?.transaction_id || `REF-${Date.now()}`, token: extractedToken, status: 'success', raw: response.data };
    } else { throw new Error(`Provider Error: ${response.data.response_description || response.data.message}`); }
  } catch (error) {
    throw new Error(error.response?.data?.response_description || error.response?.data?.message || error.message);
  }
}

// ---------------------------------------------------------------------
// ATOMIC ROUTE HANDLERS
// ---------------------------------------------------------------------

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
    if (variationsCache[serviceID] && (Date.now() - variationsCache[serviceID].timestamp < CACHE_TIME)) return reply.send({ success: true, variations: variationsCache[serviceID].data });

    const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
    const response = await axios.get(`${baseUrl}/service-variations?serviceID=${serviceID}`, { headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }, timeout: 15000 });
    
    const fetchedVariations = response.data.content?.varations || response.data.content?.variations || [];
    if (fetchedVariations.length > 0) variationsCache[serviceID] = { timestamp: Date.now(), data: fetchedVariations };
    
    reply.send({ success: true, variations: fetchedVariations });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch service plans' }); }
}

async function buyAirtime(request, reply) {
  try {
    const { phone, network, amount, pin } = request.body;
    if (!phone || !network || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'airtime', request.user.role));

    // STEP 1: ATOMIC DEBIT
    const session = await mongoose.startSession();
    session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'airtime', description: `${network.toUpperCase()} Airtime for ${phone}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction();
        session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    // STEP 2: EXTERNAL API CALL
    try {
      const providerResponse = await processVTURequest('airtime', { phone, network, amount });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference;
      await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'airtime_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Airtime purchase successful', transaction });
    } catch (vtuError) {
      // STEP 3: ATOMIC REFUND
      const refundSession = await mongoose.startSession();
      refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance);
      await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Airtime Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buyData(request, reply) {
  try {
    const { phone, network, plan, amount, pin } = request.body;
    if (!phone || !network || !amount || !plan) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    let variations = variationsCache[network]?.data || [];
    if (variations.length === 0) {
        const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
        const response = await axios.get(`${baseUrl}/service-variations?serviceID=${network}`, { headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }, timeout: 15000 });
        variations = response.data.content?.varations || response.data.content?.varations || [];
    }
    
    const selectedPlanData = variations.find(v => v.variation_code === plan);
    if (!selectedPlanData) return reply.status(400).send({ success: false, message: 'Invalid data plan selected' });

    const exactAmount = sanitizeAmount(selectedPlanData.variation_amount);
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(exactAmount, 'data', request.user.role));

    const session = await mongoose.startSession();
    session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'data', description: `Data Plan for ${phone}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('data', { phone, network, plan, amount: exactAmount });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'data_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Data purchase successful', transaction });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Data Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buyElectricity(request, reply) {
  try {
    const { meterNumber, disco, amount, meterType, pin, phone } = request.body; 
    if (!meterNumber || !disco || !amount || !meterType) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    if (parseFloat(amount) < 500) return reply.status(400).send({ success: false, message: 'Minimum electricity purchase amount is ₦500.' });
    if (disco === 'ibadan-electric' && parseFloat(amount) < 2000) return reply.status(400).send({ success: false, message: 'IBEDC requires a minimum purchase of ₦2,000.' });

    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'electricity', request.user.role));

    const session = await mongoose.startSession(); session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'electricity', description: `Electricity (${disco.toUpperCase()}) - Meter: ${meterNumber}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('electricity', { meterNumber, disco, amount, meterType, phone });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'electricity_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Electricity payment successful', transaction, token: providerResponse.token });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Electricity Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buyCable(request, reply) {
  try {
    const { smartcardNumber, provider, package: pkg, amount, pin, phone } = request.body; 
    if (!smartcardNumber || !provider || !amount || !pkg) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'cable', request.user.role));

    const session = await mongoose.startSession(); session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'cable', description: `Cable (${provider.toUpperCase()}) for ${smartcardNumber}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('cable', { smartcardNumber, provider, package: pkg, amount, phone });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'cable_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Cable subscription successful', transaction, token: providerResponse.token });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Cable Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buyEducation(request, reply) {
  try {
    const { provider, phone, quantity, amount, pin } = request.body;
    if (!provider || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const validPhone = phone || '08000000000'; const validQty = quantity || 1;
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'education', request.user.role));

    const session = await mongoose.startSession(); session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'education', description: `${provider.toUpperCase()} PIN sent`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('education', { provider, phone: validPhone, quantity: validQty, amount });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'education_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Exam PIN processed successfully', transaction, token: providerResponse.token });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Education Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buyBetting(request, reply) {
  try {
    const { provider, customerId, amount, pin, phone } = request.body; 
    if (!provider || !customerId || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'betting', request.user.role));

    const session = await mongoose.startSession(); session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'betting', description: `Betting Wallet Funding (${provider.toUpperCase()}) for ${customerId}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('betting', { provider, customerId, amount, phone });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'betting_fund', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Betting wallet funded successfully', transaction });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Betting Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buyInsurance(request, reply) {
  try {
    const { provider, phone, amount, pin } = request.body;
    if (!provider || !phone || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'insurance', request.user.role));

    const session = await mongoose.startSession(); session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'insurance', description: `Insurance (${provider.toUpperCase()}) for ${phone}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('insurance', { provider, phone, amount });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'insurance_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'Insurance purchased successfully', transaction });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Insurance Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

async function buySms(request, reply) {
  try {
    const { provider, phone, amount, pin } = request.body;
    if (!phone || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'sms', request.user.role));

    const session = await mongoose.startSession(); session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'sms', description: `Bulk SMS units purchased`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    try {
      const providerResponse = await processVTURequest('sms', { provider: provider || 'bulk-sms', phone, amount });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference; await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'sms_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      reply.send({ success: true, message: 'SMS units purchased successfully', transaction });
    } catch (vtuError) {
      const refundSession = await mongoose.startSession(); refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance); await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('SMS Error', error); reply.status(500).send({ success: false, message: 'System error' }); }
}

// FIX: Added the exact VTpass unwrapping logic directly to your provided code
async function getInternationalCountries(request, reply) {
  try {
    const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
    const response = await axios.get(`${baseUrl}/get-international-airtime-countries`, { 
        headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }, 
        timeout: 15000 
    });
    // FIX: Extract countries array directly from VTpass payload
    const countryList = response.data.content?.countries || response.data.content || [];
    return reply.send({ success: true, countries: countryList });
  } catch (error) { 
    return reply.status(500).send({ success: false, message: 'Failed to fetch countries' }); 
  }
}

// FIX: Added the exact VTpass unwrapping logic directly to your provided code
async function getInternationalOperators(request, reply) {
  try {
    const { code } = request.query;
    const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
    // FIX: Changed product_type_id to 1 (Airtime) as requested
    const response = await axios.get(`${baseUrl}/get-international-airtime-operators?code=${code}&product_type_id=1`, { 
        headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }, 
        timeout: 15000 
    });
    // FIX: Extract operators array directly from VTpass payload
    const opList = response.data.content?.operators || response.data.content || [];
    return reply.send({ success: true, operators: opList });
  } catch (error) { 
    return reply.status(500).send({ success: false, message: 'Failed to fetch operators' }); 
  }
}

// FIX: Passing the country and email required by VTpass
async function buyForeignAirtime(request, reply) {
  try {
    const { phone, operator, country, amount, pin } = request.body;
    if (!phone || !operator || !amount || !country) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const pinCheck = await validateTransactionPin(request.user._id, pin);
    if (!pinCheck.isValid) return reply.status(401).send({ success: false, message: pinCheck.message });
    
    const payableAmount = sanitizeAmount(applyEnterpriseDiscount(parseFloat(amount), 'airtime', request.user.role));

    // STEP 1: ATOMIC DEBIT
    const session = await mongoose.startSession();
    session.startTransaction();
    let transaction;
    try {
        const wallet = await Wallet.findOneAndUpdate(
            { user: request.user._id, availableBalance: { $gte: payableAmount }, isFrozen: { $ne: true } },
            { $inc: { availableBalance: -payableAmount, balance: -payableAmount } },
            { session, new: true }
        );
        if (!wallet) throw new Error('Insufficient balance or wallet frozen');

        transaction = new Transaction({
            user: request.user._id, type: 'foreign-airtime', description: `Intl Airtime (${operator}) for ${phone}`,
            amount: payableAmount, fee: 0, balanceBefore: String(sanitizeAmount(wallet.availableBalance) + payableAmount), balanceAfter: String(wallet.availableBalance),
            status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
        });
        await transaction.save({ session });
        await session.commitTransaction();
        session.endSession();
    } catch(err) {
        await session.abortTransaction(); session.endSession();
        return reply.status(400).send({ success: false, message: err.message });
    }

    // STEP 2: EXTERNAL API CALL
    try {
      const providerResponse = await processVTURequest('foreign-airtime', { phone, operator, country, amount, email: request.user.email });
      transaction.status = 'success'; transaction.providerReference = providerResponse.reference;
      await transaction.save();
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'foreign_airtime_purchase', previousBalance: transaction.balanceBefore, newBalance: transaction.balanceAfter, ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: 'VTU API' });
      await registerSuccessfulSpend(request.user._id, payableAmount, request.server.io);
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: transaction.balanceAfter });
      return reply.send({ success: true, message: 'International Airtime successful', transaction });
    } catch (vtuError) {
      // STEP 3: ATOMIC REFUND
      const refundSession = await mongoose.startSession();
      refundSession.startTransaction();
      const refundedWallet = await Wallet.findOneAndUpdate({ user: request.user._id }, { $inc: { availableBalance: payableAmount, balance: payableAmount } }, { session: refundSession, new: true });
      transaction.status = 'failed'; transaction.balanceAfter = String(refundedWallet.availableBalance);
      await transaction.save({ session: refundSession });
      await createAuditLog({ user: request.user._id, transactionId: transaction._id, reference: transaction.reference, amount: payableAmount, type: 'vtu_refund', previousBalance: String(sanitizeAmount(refundedWallet.availableBalance) - payableAmount), newBalance: String(refundedWallet.availableBalance), ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: 'VTU API Error' }, refundSession);
      await refundSession.commitTransaction(); refundSession.endSession();
      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(refundedWallet.availableBalance) });
      return reply.status(400).send({ success: false, message: vtuError.message });
    }
  } catch (error) { logger.error('Foreign Airtime Error', error); return reply.status(500).send({ success: false, message: 'System error' }); }
}

module.exports = {
  getRates, getVariations, buyAirtime, buyData, buyElectricity, buyCable, buyEducation, buyBetting, buyInsurance, buySms,
  getInternationalCountries, getInternationalOperators, buyForeignAirtime 
};
