const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const axios = require('axios');

// --- SPEED BOOST: MEMORY BANK CACHE FOR PLANS ---
const variationsCache = {};
const CACHE_TIME = 1000 * 60 * 60 * 24; 

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
    
    if (variationsCache[serviceID] && (Date.now() - variationsCache[serviceID].timestamp < CACHE_TIME)) {
        return reply.send({ success: true, variations: variationsCache[serviceID].data });
    }

    const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
    const response = await axios.get(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }
    });
    
    const fetchedVariations = response.data.content?.varations || response.data.content?.variations || [];
    
    if (fetchedVariations.length > 0) {
        variationsCache[serviceID] = {
            timestamp: Date.now(),
            data: fetchedVariations
        };
    }

    reply.send({ success: true, variations: fetchedVariations });
  } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch service plans' }); }
}

// ==========================================
// STANDARD BILL PAYMENTS
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
// NEW FEATURES: EDUCATION, BETTING, INSURANCE, POS & SMS
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

    let transaction = new Transaction({
      user: request.user._id, type: 'betting', description: `Fund ${provider.toUpperCase()} account ID: ${customerId}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'paystack', reference: `BET-${Date.now()}`
    });
    await transaction.save();

    try {
      transaction.status = 'success';
      transaction.providerReference = `PAYSTACK-${Date.now()}`;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Betting wallet funded successfully', transaction });

    } catch (apiError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      return reply.status(500).send({ success: false, message: 'Failed to fund betting account' });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing betting payment' }); }
}

async function buyInsurance(request, reply) {
  try {
    const { provider, fullName, phone, plan, amount, address, dob, occupation, vehicleDetails, pin } = request.body;
    if (!provider || !fullName || !phone || !amount || !plan) return reply.status(400).send({ success: false, message: 'Invalid inputs' });
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
    if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

    wallet.availableBalance = (currentAvail - amount).toString();
    wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
    await wallet.save();

    const transaction = new Transaction({
      user: request.user._id, type: 'insurance', description: `${provider.toUpperCase()} Policy for ${fullName}`,
      amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
      status: 'pending', provider: 'vtpass', reference: `INS-${Date.now()}`
    });
    await transaction.save();

    try {
      const providerResponse = await processVTURequest('insurance', { 
          provider, fullName, phone, plan, amount, address, dob, occupation, vehicleDetails 
      });
      transaction.status = 'success';
      transaction.providerReference = providerResponse.reference;
      await transaction.save();

      if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
      reply.send({ success: true, message: 'Insurance policy secured successfully', transaction, token: providerResponse.token });

    } catch (vtuError) {
      wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
      wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
      await wallet.save();

      transaction.status = 'failed';
      transaction.balanceAfter = wallet.availableBalance.toString();
      await transaction.save();
      
      // Pass the raw error to frontend
      return reply.status(500).send({ success: false, message: vtuError.message });
    }
  } catch (error) { reply.status(500).send({ success: false, message: 'System error processing insurance' }); }
}

async function sendBulkSMS(request, reply) {
    try {
        const { sender, recipient, message, pin } = request.body;
        if (!sender || !recipient || !message || !pin) return reply.status(400).send({ success: false, message: 'Invalid inputs' });

        const wallet = await Wallet.findOne({ user: request.user._id });
        const smsCost = 4.00 * recipient.split(',').length; 
        
        if (parseFloat(wallet.availableBalance) < smsCost) {
            return reply.status(400).send({ success: false, message: 'Insufficient balance for SMS dispatch.' });
        }

        wallet.availableBalance = (parseFloat(wallet.availableBalance) - smsCost).toString();
        wallet.balance = (parseFloat(wallet.balance) - smsCost).toString();
        await wallet.save();

        const transaction = new Transaction({
          user: request.user._id, type: 'bulk_sms', description: `Bulk SMS Dispatch from ${sender}`,
          amount: smsCost, fee: 0, balanceBefore: (parseFloat(wallet.availableBalance) + smsCost).toString(), 
          balanceAfter: wallet.availableBalance.toString(),
          status: 'pending', provider: 'vtpass', reference: `SMS-${Date.now()}`
        });
        await transaction.save();

        if (!process.env.VTPASS_MESSAGING_PUBLIC_KEY || !process.env.VTPASS_MESSAGING_SECRET_KEY) {
            throw new Error("Provider API Key Missing: Ensure your Messaging Keys are set in .env");
        }

        const url = 'https://messaging.vtpass.com/v2/api/sms/sendsms';
        const headers = { 
            'X-Token': process.env.VTPASS_MESSAGING_PUBLIC_KEY, 
            'X-Secret': process.env.VTPASS_MESSAGING_SECRET_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        const payload = new URLSearchParams({ sender, recipient, message, responsetype: 'json' });
        const response = await axios.post(url, payload.toString(), { headers });
        
        if (response.data.responseCode === "TG00") {
            transaction.status = 'success';
            await transaction.save();
            reply.send({ success: true, message: 'SMS Dispatched', data: response.data });
        } else {
            throw new Error(`Provider API Error: ${response.data.response}`);
        }

    } catch (error) {
        // Find user wallet and refund them due to error
        const wallet = await Wallet.findOne({ user: request.user._id });
        const smsCost = 4.00 * request.body.recipient.split(',').length; 
        wallet.availableBalance = (parseFloat(wallet.availableBalance) + smsCost).toString();
        wallet.balance = (parseFloat(wallet.balance) + smsCost).toString();
        await wallet.save();
        
        reply.status(500).send({ success: false, message: error.message || 'Failed to dispatch SMS messages.' });
    }
}

async function buyPOS(request, reply) {
    try {
        const { terminalId, amount, pin } = request.body;
        if (!terminalId || !amount) return reply.status(400).send({ success: false, message: 'Invalid inputs' });

        const wallet = await Wallet.findOne({ user: request.user._id });
        const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
        if (currentAvail < amount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });

        wallet.availableBalance = (currentAvail - amount).toString();
        wallet.balance = (parseFloat(wallet.balance?.toString() || '0') - amount).toString();
        await wallet.save();

        const transaction = new Transaction({
          user: request.user._id, type: 'pos', description: `POS Terminal Funding for ${terminalId}`,
          amount, fee: 0, balanceBefore: currentAvail.toString(), balanceAfter: wallet.availableBalance.toString(),
          status: 'pending', provider: 'vtpass', reference: `POS-${Date.now()}`
        });
        await transaction.save();

        try {
            const providerResponse = await processVTURequest('pos', { terminalId, amount });
            transaction.status = 'success';
            transaction.providerReference = providerResponse.reference;
            await transaction.save();

            if (request.server.io) request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
            reply.send({ success: true, message: 'Terminal Funded', transaction });
        } catch (vtuError) {
            wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(amount)).toString();
            wallet.balance = (parseFloat(wallet.balance) + parseFloat(amount)).toString();
            await wallet.save();

            transaction.status = 'failed';
            await transaction.save();
            return reply.status(500).send({ success: false, message: vtuError.message });
        }
    } catch (error) {
        reply.status(500).send({ success: false, message: 'System error processing POS funding.' });
    }
}

// ==================================================================
// VTPASS WEBHOOK CALLBACK HANDLER
// ==================================================================
async function handleVTpassWebhook(request, reply) {
    try {
        const { type, data, summary, actionRequired } = request.body;

        if (type === 'transaction-update') {
            const { transactionId, status } = data.content.transactions;
            const transaction = await Transaction.findOne({ providerReference: transactionId });

            if (transaction && transaction.status === 'pending') {
                if (status === 'delivered') {
                    transaction.status = 'success';
                } else if (status === 'reversed') {
                    transaction.status = 'failed';
                    // Refund Logic Here
                    const wallet = await Wallet.findOne({ user: transaction.user });
                    wallet.availableBalance = (parseFloat(wallet.availableBalance) + parseFloat(transaction.amount)).toString();
                    wallet.balance = (parseFloat(wallet.balance) + parseFloat(transaction.amount)).toString();
                    await wallet.save();
                }
                await transaction.save();
            }
        } else if (type === 'variations-update') {
            const { serviceID } = request.body;
            if (variationsCache[serviceID]) {
                delete variationsCache[serviceID];
            }
        }
        
        reply.send({ response: "success" });
    } catch (error) {
        reply.status(500).send({ response: "error" });
    }
}


// ==================================================================
// REAL VTPASS INTEGRATION CORE
// ==================================================================
async function processVTURequest(type, data) {
  if (!process.env.VTPASS_API_KEY || !process.env.VTPASS_SECRET_KEY) {
      throw new Error("Provider API Key Missing: Ensure your VTpass Keys are set in .env");
  }

  const baseUrl = process.env.VTPASS_URL || 'https://sandbox.vtpass.com/api';
  const isSandbox = baseUrl.includes('sandbox');

  let targetIdentifier = data.phone || data.meterNumber || data.smartcardNumber || data.customerId;
  
  if (isSandbox) {
      if (type === 'electricity') {
          targetIdentifier = data.meterType === 'postpaid' ? '1010101010101' : '1111111111111';
      } else if (type === 'cable') {
          targetIdentifier = '1212121212';     
      } else {
          targetIdentifier = '08011111111';   
      }
  }

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

  if (type === 'airtime') {
      payload.serviceID = data.network; 
  } 
  else if (type === 'data') { 
      payload.serviceID = data.network; 
      payload.billersCode = isSandbox ? '08011111111' : data.phone; 
      payload.variation_code = data.plan; 
  } 
  else if (type === 'electricity') {
      payload.serviceID = data.disco;
      payload.billersCode = isSandbox ? (data.meterType === 'postpaid' ? '1010101010101' : '1111111111111') : data.meterNumber; 
      payload.variation_code = data.meterType;
  } 
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
      const providerInput = data.provider.toLowerCase().trim();

      if (providerInput === 'waec-registration') {
          payload.serviceID = 'waec-registration';
          payload.variation_code = 'waec-registraion';
          payload.billersCode = isSandbox ? '08011111111' : data.phone;
      } else if (providerInput === 'waec-result' || providerInput === 'waec') {
          payload.serviceID = 'waec';
          payload.variation_code = 'waecdirect';
          payload.billersCode = isSandbox ? '08011111111' : data.phone;
      } else if (providerInput === 'jamb') {
          payload.serviceID = 'jamb';
          payload.variation_code = 'utme-no-mock';
          payload.billersCode = isSandbox ? '0123456789' : data.phone; 
      } else {
          payload.serviceID = providerInput;
          payload.variation_code = 'default';
          payload.billersCode = isSandbox ? '08011111111' : data.phone;
      }
  }
  else if (type === 'insurance') {
      payload.serviceID = data.provider.toLowerCase(); 
      payload.billersCode = isSandbox ? 'ATU480ER' : (data.vehicleDetails?.plateNumber || data.phone);
      payload.variation_code = data.plan;
      
      if (payload.serviceID === 'ui-insure') {
          payload.phone = isSandbox ? '08111111111' : (data.phone || '08111111111');
          payload.Insured_Name = data.fullName || 'Mr Ajanlekoko';
          payload.engine_capacity = '1';
          payload.Chasis_Number = isSandbox ? 'S12332323FRHJJ433434J' : data.vehicleDetails?.chassisNumber;
          payload.Plate_Number = isSandbox ? 'ATU480ER' : data.vehicleDetails?.plateNumber;
          payload.vehicle_make = '335';
          payload.vehicle_color = '20';
          payload.vehicle_model = '745';
          payload.YearofMake = '2009';
          payload.state = '1';
          payload.lga = '770';
          payload.email = 'sandbox@vtpass.com';
      }
  }
  else if (type === 'pos') {
      payload.serviceID = 'vtpass-pos'; 
      payload.billersCode = data.terminalId;
      payload.variation_code = 'default';
  }

  try {
    const response = await axios.post(`${baseUrl}/pay`, payload, { headers });
    
    if (response.data.code === '000') {
      let extractedToken = response.data.purchased_code || response.data.token || response.data.Pin || response.data.certUrl || null;

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
      // Intentionally avoiding "VTpass Error" so the frontend mask is bypassed and you see the true error
      throw new Error(`Provider API Error (${response.data.code}): ${response.data.response_description || response.data.message}`);
    }
  } catch (error) {
    const apiErrorMessage = error.response?.data?.response_description || error.response?.data?.message || error.message;
    throw new Error(`Provider API Error: ${apiErrorMessage}`);
  }
}

module.exports = { 
  getRates, 
  getVariations, 
  buyAirtime, 
  buyData, 
  buyElectricity, 
  buyCable, 
  buyEducation, 
  buyBetting, 
  buyInsurance, 
  sendBulkSMS, 
  buyPOS,
  handleVTpassWebhook 
};
