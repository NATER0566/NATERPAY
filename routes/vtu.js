const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const axios = require('axios');

// --- HELPER: VTPASS STRICT REQUEST ID FORMATTER ---
function generateVTpassRequestId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  return dateStr + randomSuffix;
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

// ==========================================
// STANDARD BILL PAYMENTS (AIRTIME & DATA)
// ==========================================

async function buyAirtime(request, reply) {
  try {
    const { phone, network, amount, pin } = request.body;
    if (!phone || !network || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'airtime', description: `${network.toUpperCase()} Airtime for ${phone}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('airtime', { phone, network, amount });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Airtime purchase successful', transaction });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing airtime' }); }
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
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing data' }); }
}

// ==========================================
// UTILITIES & MULTIMEDIA (POWER & CABLE)
// ==========================================

async function buyElectricity(request, reply) {
  try {
    const { meterNumber, disco, amount, meterType, pin } = request.body;
    if (!meterNumber || !disco || !amount || !meterType) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'electricity', description: `Electricity (${disco.toUpperCase()}) - Meter: ${meterNumber}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('electricity', { meterNumber, disco, amount, meterType });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Electricity payment successful', transaction, token: providerResponse.token });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing electricity' }); }
}

async function buyCable(request, reply) {
  try {
    const { smartcardNumber, provider, package: pkg, amount, pin } = request.body;
    if (!smartcardNumber || !provider || !amount || !pkg) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'cable', description: `Cable (${provider.toUpperCase()}) for ${smartcardNumber}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('cable', { smartcardNumber, provider, package: pkg, amount });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Cable subscription successful', transaction, token: providerResponse.token });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing cable' }); }
}

// ==========================================
// NEW FEATURES: EDUCATION & BETTING ROUTES
// ==========================================

async function buyEducation(request, reply) {
  try {
    const { provider, phone, quantity, amount, pin } = request.body;
    if (!provider || !phone || !quantity || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'education', description: `${provider.toUpperCase()} PIN (${quantity} Qty) sent to ${phone}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('education', { provider, phone, quantity, amount });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Exam PIN processed successfully', transaction, token: providerResponse.token });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing education token' }); }
}

async function buyBetting(request, reply) {
  try {
    const { provider, customerId, amount, pin } = request.body;
    if (!provider || !customerId || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'betting', description: `Fund ${provider.toUpperCase()} account ID: ${customerId}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `VTU-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('betting', { provider, customerId, amount });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Betting wallet funded successfully', transaction });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing betting payment' }); }
}

// ==================================================================
// REAL VTPASS INTEGRATION CORE 
// ==================================================================
async function processVTURequest(type, data) {
  if (!process.env.VTPASS_API_KEY || !process.env.VTPASS_SECRET_KEY) {
      throw new Error("VTpass API Keys are missing from server configurations.");
  }

  const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
  const isSandbox = baseUrl.includes('sandbox');

  // --- YOUR ORIGINAL WORKING SANDBOX DYNAMIC INTERCEPTOR ---
  let targetIdentifier = data.phone || data.meterNumber || data.smartcardNumber || data.customerId;
  
  if (isSandbox) {
      targetIdentifier = '08011111111';
      console.log(`[VTPASS] Sandbox Mode: Redirecting transaction to test identifier -> ${targetIdentifier}`);
  }
  // -----------------------------------

  const headers = { 
      'api-key': process.env.VTPASS_API_KEY, 
      'secret-key': process.env.VTPASS_SECRET_KEY, 
      'Content-Type': 'application/json' 
  };

  let payload = { 
      request_id: generateVTpassRequestId(), 
      amount: data.amount,
      phone: isSandbox ? '08011111111' : (data.phone || '08000000000') 
  };

  // YOUR EXACT ORIGINAL LOGIC FOR AIRTIME, DATA, ELECTRICITY
  if (type === 'airtime') {
      payload.serviceID = data.network; 
  } 
  else if (type === 'data') { 
      payload.serviceID = data.network; 
      payload.billersCode = targetIdentifier; 
      payload.variation_code = data.plan; 
  } 
  else if (type === 'electricity') {
      payload.serviceID = data.disco;
      payload.billersCode = targetIdentifier;
      payload.variation_code = data.meterType;
  } 
  
  // NEW LOGIC TO FIX CABLE AND EDUCATION ERRORS
  else if (type === 'cable') {
      payload.serviceID = data.provider.toLowerCase();
      
      const pkgInput = data.package.toString().toLowerCase().trim();
      let mappedCode = data.package; 

      if (pkgInput.includes('padi')) mappedCode = 'dstv-padi';
      else if (pkgInput.includes('yanga')) mappedCode = 'dstv-yanga';
      else if (pkgInput.includes('confam')) mappedCode = 'dstv-confam';
      else if (pkgInput.includes('compact plus')) mappedCode = 'dstv7';
      else if (pkgInput.includes('compact')) mappedCode = 'dstv79';
      else if (pkgInput.includes('premium')) mappedCode = 'dstv3';
      else if (pkgInput.includes('lite')) mappedCode = 'gotv-lite';
      else if (pkgInput.includes('max')) mappedCode = 'gotv-max';
      else if (pkgInput.includes('jolli')) mappedCode = 'gotv-jolli';
      else if (pkgInput.includes('jinja')) mappedCode = 'gotv-jinja';
      else if (pkgInput.includes('nova')) mappedCode = 'nova';
      else if (pkgInput.includes('basic')) mappedCode = 'basic';
      else if (pkgInput.includes('smart')) mappedCode = 'smart';
      
      if (isSandbox) {
          if (payload.serviceID === 'dstv') mappedCode = 'dstv79';
          else if (payload.serviceID === 'gotv') mappedCode = 'gotv-lite';
          else if (payload.serviceID === 'startimes') mappedCode = 'nova';
          else if (payload.serviceID === 'showmax') mappedCode = 'full_3';
      }

      payload.variation_code = mappedCode;

      if (payload.serviceID === 'showmax') {
          payload.billersCode = isSandbox ? '08011111111' : data.smartcardNumber;
      } else {
          payload.billersCode = isSandbox ? '1212121212' : data.smartcardNumber; 
          payload.subscription_type = 'change'; 
      }
  } 
  else if (type === 'education') {
      payload.serviceID = data.provider.toLowerCase();
      payload.quantity = parseInt(data.quantity) || 1;

      if (payload.serviceID === 'waec') {
          payload.variation_code = 'waecdirect'; 
          payload.billersCode = isSandbox ? '08011111111' : data.phone;
      } else if (payload.serviceID === 'jamb') {
          payload.variation_code = 'utme-no-mock'; 
          payload.billersCode = isSandbox ? '0123456789' : data.phone; 
      } else if (payload.serviceID === 'neco') {
          payload.variation_code = 'neco-biller'; 
          payload.billersCode = isSandbox ? '08011111111' : data.phone;
      } else {
          payload.variation_code = 'default';
          payload.billersCode = isSandbox ? '08011111111' : data.phone;
      }
  } 
  else if (type === 'betting') {
      payload.serviceID = data.provider.toLowerCase();
      payload.billersCode = isSandbox ? '08011111111' : data.customerId;
  }

  try {
    const response = await axios.post(`${baseUrl}/pay`, payload, { headers });
    
    if (response.data.code === '000') {
      let extractedToken = response.data.purchased_code || response.data.token || response.data.Pin || null;

      if (response.data.cards && Array.isArray(response.data.cards) && response.data.cards.length > 0) {
          extractedToken = `PIN: ${response.data.cards[0].Pin} | Serial: ${response.data.cards[0].Serial}`;
      } 
      else if (response.data.tokens && Array.isArray(response.data.tokens) && response.data.tokens.length > 0) {
          extractedToken = `Token: ${response.data.tokens[0]}`;
      }
      else if (response.data.Voucher && Array.isArray(response.data.Voucher) && response.data.Voucher.length > 0) {
          extractedToken = `Voucher: ${response.data.Voucher[0]}`;
      }

      return { 
          reference: response.data.content?.transactions?.transactionId || response.data.content?.transactions?.transaction_id || `REF-${Date.now()}`, 
          token: extractedToken,
          status: 'success', 
          raw: response.data 
      };
    } else {
      throw new Error(`VTpass Error (${response.data.code}): ${response.data.response_description || response.data.message}`);
    }
  } catch (error) {
    const apiErrorMessage = error.response?.data?.response_description || error.response?.data?.message || error.message;
    throw new Error(apiErrorMessage);
  }
}

module.exports = { getRates, getVariations, buyAirtime, buyData, buyElectricity, buyCable, buyEducation, buyBetting };
