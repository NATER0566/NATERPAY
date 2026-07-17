const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const config = require('../config');
const axios = require('axios');
const crypto = require('crypto'); 

// Optional imports (safely loaded so they don't crash if missing)
let AuditLog, Notification, generateIdempotencyKey, generateTransactionReference;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Notification = require('../models/Notification'); } catch(e) {}
try { 
    const authUtils = require('../utils/auth');
    generateIdempotencyKey = authUtils.generateIdempotencyKey;
    generateTransactionReference = authUtils.generateTransactionReference;
} catch(e) {}

/**
 * 1. Get Wallet
 */
async function getWallet(request, reply) {
  try {
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet not found' });
    reply.send({ success: true, wallet });
  } catch (error) {
    reply.status(500).send({ success: false, message: 'Failed to fetch wallet' });
  }
}

/**
 * 2. Initiate Wallet Funding (CENTRAL FEE ENGINE: Gateway Recovery)
 */
async function fundWallet(request, reply) {
  try {
    const { amount, provider } = request.body;
    const paymentProvider = String(provider || 'paystack').toLowerCase();
    const requestedAmount = parseFloat(amount);
    
    if (!requestedAmount || requestedAmount < (config.business?.minWithdrawal || 100)) {
      return reply.status(400).send({ success: false, message: `Minimum funding amount is ₦${config.business?.minWithdrawal || 100}` });
    }
    
    const wallet = await Wallet.findOne({ user: request.user._id });
    const user = await User.findById(request.user._id);
    if (!wallet || !user) return reply.status(404).send({ success: false, message: 'User or Wallet not found' });
    
    // --- GATEWAY RECOVERY LOGIC ---
    let gatewayFee = 0;
    if (paymentProvider === 'paystack') {
        // Paystack Fee: 1.5% + ₦100 (if over ₦2500), Capped at ₦2000
        if (requestedAmount < 2500) {
            gatewayFee = (requestedAmount * 0.015) / (1 - 0.015);
        } else {
            gatewayFee = ((requestedAmount * 0.015) + 100) / (1 - 0.015);
        }
        if (gatewayFee > 2000) gatewayFee = 2000; 
    }

    // Gross amount the user's card will actually be charged to cover the gateway
    const totalToCharge = Math.ceil(requestedAmount + gatewayFee);

    const paymentReference = typeof generateTransactionReference === 'function' ? generateTransactionReference() : `FUND_${Date.now()}`;
    const startBalance = String(wallet.availableBalance || 0);

    // Ledger records requestedAmount as principal, gatewayFee as explicit fee
    const transaction = new Transaction({
      user: request.user._id, type: 'funding', description: `Wallet funding via ${paymentProvider}`,
      amount: requestedAmount, fee: Math.ceil(gatewayFee), balanceBefore: startBalance, balanceAfter: startBalance,
      status: 'pending', provider: paymentProvider, providerReference: paymentReference,
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `idem_${Date.now()}`, 
      ipAddress: request.ip, userAgent: request.headers['user-agent']
    });
    await transaction.save();
    
    let checkoutUrl = '';
    
    if (paymentProvider === 'paystack') {
      const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize',
        { 
            email: user.email, 
            amount: totalToCharge * 100, // Charge the GROSS amount in Kobo
            reference: paymentReference, 
            callback_url: `${request.protocol}://${request.hostname}/dashboard.html` 
        },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
      );
      checkoutUrl = paystackResponse.data.data.authorization_url;
    } else if (paymentProvider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${encodedKeys}` } });
      const accessToken = authResponse.data.responseBody.accessToken;

      const initResponse = await axios.post(`${baseUrl}/api/v1/merchant/transactions/init-transaction`,
        { amount: totalToCharge, customerName: user.name, customerEmail: user.email, paymentReference: paymentReference, paymentDescription: 'NATERPAY Wallet Funding', currencyCode: 'NGN', contractCode: process.env.MONNIFY_CONTRACT_CODE, redirectUrl: `${request.protocol}://${request.hostname}/dashboard.html` },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      checkoutUrl = initResponse.data.responseBody.checkoutUrl;
    } else {
      return reply.status(400).send({ success: false, message: 'Unsupported payment provider' });
    }
    
    reply.send({ success: true, message: 'Payment initialized', paymentReference, checkoutUrl, provider: paymentProvider });
  } catch (error) {
    console.error('Funding Error:', error.message);
    reply.status(500).send({ success: false, message: 'Failed to initiate payment gateway.' });
  }
}

/**
 * 3. Verify Wallet Funding (CENTRAL FEE ENGINE: Net Ledger Protection)
 */
async function verifyFunding(request, reply) {
  try {
    const { reference } = request.body;
    if (!reference) return reply.status(400).send({ success: false, message: 'Payment reference is required' });
    
    const transaction = await Transaction.findOne({ providerReference: reference });
    if (!transaction) return reply.status(404).send({ success: false, message: 'Transaction not found' });
    
    if (transaction.status === 'success') return reply.send({ success: true, message: 'Wallet already credited' });
    if (transaction.status === 'failed') return reply.status(400).send({ success: false, message: 'Transaction was cancelled or declined.' });

    let gatewayStatus = 'pending';

    if (transaction.provider === 'paystack') {
      const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { 
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } 
      });
      gatewayStatus = response.data.data.status; 
    } 
    else if (transaction.provider === 'monnify') {
      const baseUrl = process.env.MONNIFY_URL || 'https://sandbox.monnify.com';
      const encodedKeys = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
      const authResponse = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${encodedKeys}` } });
      const accessToken = authResponse.data.responseBody.accessToken;
      
      const response = await axios.get(`${baseUrl}/api/v1/merchant/transactions/query?paymentReference=${reference}`, { 
          headers: { Authorization: `Bearer ${accessToken}` } 
      });
      
      const monnifyStatus = response.data.responseBody.paymentStatus;
      if (monnifyStatus === 'PAID') gatewayStatus = 'success';
      else if (monnifyStatus === 'FAILED' || monnifyStatus === 'CANCELLED' || monnifyStatus === 'EXPIRED') gatewayStatus = 'failed';
    }

    if (gatewayStatus === 'abandoned' || gatewayStatus === 'failed') {
        transaction.status = 'failed';
        transaction.metadata = transaction.metadata || {};
        transaction.metadata.reason = 'User abandoned checkout or bank declined.';
        await transaction.save();
        return reply.status(400).send({ success: false, message: 'Payment was cancelled or declined. Marked as failed in ledger.' });
    }

    if (gatewayStatus !== 'success') {
        return reply.status(400).send({ success: false, message: 'Payment is still pending at the gateway. Awaiting settlement.' });
    }

    const wallet = await Wallet.findOne({ user: transaction.user });
    
    // --- CENTRAL FEE ENGINE: Credit exact requested principal ONLY ---
    // The gateway swallowed the gross-up fee. We credit exactly what the user asked for.
    const creditAmount = transaction.amount; 

    wallet.availableBalance = String(parseFloat(wallet.availableBalance || 0) + creditAmount);
    wallet.balance = String(parseFloat(wallet.balance || 0) + creditAmount);
    await wallet.save();
    
    transaction.status = 'success';
    transaction.balanceAfter = String(wallet.availableBalance || 0);
    await transaction.save();
    
    if (Notification && typeof Notification.create === 'function') {
        await Notification.create({ user: transaction.user, title: 'Wallet Funded', message: `Your wallet was credited with ₦${creditAmount.toLocaleString()}`, type: 'transaction', priority: 'high' }).catch(() => {});
    }
    if (request.server && request.server.io) {
        request.server.io.to(`user:${transaction.user}`).emit('wallet:update', { balance: String(wallet.availableBalance || 0) });
    }
    
    reply.send({ success: true, message: 'Payment verified and wallet credited!' });

  } catch (error) {
    console.error('Verify Funding Error:', error.message);
    reply.status(500).send({ success: false, message: 'Failed to verify payment. Network error.' });
  }
}

/**
 * 4. Withdraw Engine (CENTRAL FEE ENGINE: Tiered Platform Fees)
 */
async function withdraw(request, reply) {
  try {
    const { amount, bankAccount, pin } = request.body;
    
    const withdrawAmount = parseFloat(amount);
    const minWth = config.business?.minWithdrawal || 1000;
    const maxWth = config.business?.maxWithdrawal || 500000;

    if (!withdrawAmount || withdrawAmount < minWth) {
      return reply.status(400).send({ success: false, message: `Minimum withdrawal amount is ₦${minWth}` });
    }
    if (withdrawAmount > maxWth) {
      return reply.status(400).send({ success: false, message: `Maximum withdrawal amount is ₦${maxWth}` });
    }
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    
    if (!wallet) return reply.status(404).send({ success: false, message: 'Wallet error.' });
    if (wallet.isFrozen) return reply.status(403).send({ success: false, message: 'Wallet is frozen. Please contact support.' });
    if (!pin) return reply.status(400).send({ success: false, message: 'Security PIN is required' });
    
    let isPinValid = false;
    if (typeof wallet.verifyPin === 'function') {
        isPinValid = await wallet.verifyPin(String(pin));
    } else if (user.transactionPin) {
        isPinValid = await bcrypt.compare(String(pin), user.transactionPin);
    } else {
        return reply.status(400).send({ success: false, message: 'Please setup your withdrawal PIN in settings first.' });
    }

    if (!isPinValid) return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Withdrawal PIN.' });

    // --- CENTRAL FEE ENGINE: Tiered Withdrawal Cost ---
    let transferFee = 10; 
    if (withdrawAmount > 5000 && withdrawAmount <= 50000) {
        transferFee = 25;
    } else if (withdrawAmount > 50000) {
        transferFee = 50;
    }
    
    const totalDeduction = withdrawAmount + transferFee;
    const currentAvail = parseFloat(wallet.availableBalance || 0);
    
    if (currentAvail < totalDeduction) {
      return reply.status(400).send({ success: false, message: `Insufficient Funds. You need ₦${totalDeduction.toLocaleString()} including the ₦${transferFee} processing fee.` });
    }
    
    // Deduct user wallet. 
    // Manual Profit Custodian: Fee stays in physical admin bank account. No virtual admin routing needed.
    wallet.availableBalance = String(currentAvail - totalDeduction);
    wallet.balance = String(parseFloat(wallet.balance || 0) - totalDeduction);
    await wallet.save();
    
    const safeBankName = String(bankAccount?.bankName || 'Bank').toUpperCase();
    const safeAccountNo = String(bankAccount?.accountNumber || 'Unknown');

    const transaction = new Transaction({
      user: request.user._id, 
      type: 'withdrawal', 
      description: `Withdrawal to ${safeBankName} - ${safeAccountNo}`,
      amount: withdrawAmount, 
      fee: transferFee, 
      balanceBefore: String(currentAvail), 
      balanceAfter: String(wallet.availableBalance || 0),
      status: 'pending', // Awaiting physical admin payout
      provider: 'internal', 
      idempotencyKey: typeof generateIdempotencyKey === 'function' ? generateIdempotencyKey() : `wth_${Date.now()}`, 
      ipAddress: request.ip, 
      userAgent: request.headers['user-agent'],
      
      bankName: bankAccount?.bankName || safeBankName,
      accountNumber: bankAccount?.accountNumber || safeAccountNo,
      accountName: bankAccount?.accountName || 'Unknown',
      metadata: { bankAccount }
    });
    
    await transaction.save();
    
    if (request.server && request.server.io) {
        request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(wallet.availableBalance || 0) });
    }
    
    reply.send({ success: true, message: 'Withdrawal request submitted. Awaiting manual payout.', transaction });
  } catch (error) {
    console.error('Withdrawal Server Error:', error); 
    reply.status(500).send({ success: false, message: error.message || 'System error processing transfer.' });
  }
}

/**
 * 5. Peer-to-Peer Transfer (STRICTLY FREE)
 */
async function transfer(request, reply) {
  try {
    const { amount, recipient, pin } = request.body; 
    const transferAmount = parseFloat(amount);
    
    if (!transferAmount || transferAmount < 100) return reply.status(400).send({ success: false, message: 'Minimum transfer amount is ₦100' });
    
    const senderWallet = await Wallet.findOne({ user: request.user._id });
    const sender = await User.findById(request.user._id);

    if (!pin) return reply.status(400).send({ success: false, message: 'PIN entry is required.' });
    
    let isPinValid = false;
    if (typeof senderWallet.verifyPin === 'function') {
        isPinValid = await senderWallet.verifyPin(String(pin));
    } else if (sender.transactionPin) {
        isPinValid = await bcrypt.compare(String(pin), sender.transactionPin);
    } else {
        return reply.status(400).send({ success: false, message: 'Please setup your transfer PIN in settings first.' });
    }

    if (!isPinValid) return reply.status(401).send({ success: false, message: 'SECURITY ALERT: Incorrect Transfer PIN.' });

    const currentAvail = parseFloat(senderWallet.availableBalance || 0);
    if (currentAvail < transferAmount) return reply.status(400).send({ success: false, message: 'Insufficient balance' });
    
    let query = { $or: [{ email: String(recipient).toLowerCase() }, { phoneNumber: String(recipient) }] };
    if (require('mongoose').Types.ObjectId.isValid(recipient)) query.$or.push({ _id: recipient });

    const recipientUser = await User.findOne(query);
    if (!recipientUser) return reply.status(404).send({ success: false, message: 'Recipient NATERPAY ID not found' });
    if (recipientUser._id.toString() === request.user._id.toString()) return reply.status(400).send({ success: false, message: 'You cannot transfer to yourself' });
    
    const recipientWallet = await Wallet.findOne({ user: recipientUser._id });
    if (!recipientWallet) return reply.status(404).send({ success: false, message: 'Recipient wallet not configured' });

    senderWallet.availableBalance = String(currentAvail - transferAmount);
    senderWallet.balance = String(parseFloat(senderWallet.balance || 0) - transferAmount);
    await senderWallet.save();
    
    recipientWallet.availableBalance = String(parseFloat(recipientWallet.availableBalance || 0) + transferAmount);
    recipientWallet.balance = String(parseFloat(recipientWallet.balance || 0) + transferAmount);
    await recipientWallet.save();
    
    const senderTransaction = new Transaction({
      user: request.user._id, type: 'transfer', description: `Transfer to ${recipientUser.name}`,
      amount: transferAmount, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(senderWallet.availableBalance || 0),
      status: 'success', provider: 'internal'
    });
    
    const recipientTransaction = new Transaction({
      user: recipientUser._id, type: 'transfer', description: `Received from ${sender.name}`,
      amount: transferAmount, fee: 0, 
      balanceBefore: String(parseFloat(recipientWallet.availableBalance || 0) - transferAmount), 
      balanceAfter: String(recipientWallet.availableBalance || 0),
      status: 'success', provider: 'internal'
    });
    
    await senderTransaction.save();
    await recipientTransaction.save();
    
    if (request.server && request.server.io) {
      request.server.io.to(`user:${request.user._id}`).emit('wallet:update', { balance: String(senderWallet.availableBalance || 0) });
      request.server.io.to(`user:${recipientUser._id}`).emit('wallet:update', { balance: String(recipientWallet.availableBalance || 0) });
      request.server.io.to(`user:${recipientUser._id}`).emit('notification', { title: 'Funds Received', message: `₦${transferAmount.toLocaleString()} received from ${sender.name}` });
    }
    
    reply.send({ success: true, message: 'Transfer successful', transaction: senderTransaction, recipientName: recipientUser.name });
  } catch (error) {
    console.error('Transfer Server Error:', error);
    reply.status(500).send({ success: false, message: 'Failed to process transfer. Check console.' });
  }
}

/**
 * 6. Set PIN
 */
async function setPin(request, reply) {
  try {
    const { pin, confirmPin } = request.body;
    if (!pin || String(pin).length !== 4) return reply.status(400).send({ success: false, message: 'PIN must be 4 digits' });
    if (String(pin) !== String(confirmPin)) return reply.status(400).send({ success: false, message: 'PINs do not match' });
    
    const user = await User.findById(request.user._id);
    const wallet = await Wallet.findOne({ user: request.user._id });
    if (!user || !wallet) return reply.status(404).send({ success: false, message: 'Account not found' });
    
    if (typeof wallet.setPin === 'function') {
        await wallet.setPin(String(pin));
    } 
    const salt = await bcrypt.genSalt(10);
    user.transactionPin = await bcrypt.hash(String(pin), salt);
    user.isSecured = true;
    await user.save();
    
    reply.send({ success: true, message: 'PIN set successfully' });
  } catch (error) {
    console.error('Set PIN Error:', error);
    reply.status(500).send({ success: false, message: 'Failed to set PIN' });
  }
}

/**
 * 7. Resolve Bank Account
 */
async function resolveBankAccount(request, reply) {
    try {
        const { accountNumber, bankCode } = request.body;
        if (!accountNumber || !bankCode) {
            return reply.status(400).send({ success: false, message: 'Account Number and Bank Code required' });
        }

        const response = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });

        reply.send({ success: true, accountName: response.data.data.account_name });
    } catch (error) {
        console.error("Bank Resolve Error:", error.response?.data || error.message);
        reply.status(400).send({ success: false, message: 'Invalid Account Details.' });
    }
}

/**
 * 8. PAYSTACK SECURE WEBHOOK (CENTRAL FEE ENGINE: Absolute Net Validation)
 */
async function handlePaystackWebhook(request, reply) {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(request.body)).digest('hex');

        if (hash !== request.headers['x-paystack-signature']) {
            return reply.status(401).send({ success: false, message: 'Invalid Signature - Unauthorized Access' });
        }

        const event = request.body;

        if (event.event === 'charge.success') {
            const data = event.data;
            const reference = data.reference;
            
            const existingTx = await Transaction.findOne({ providerReference: reference, status: 'success' });
            if (existingTx) {
                return reply.code(200).send('Transaction already processed');
            }

            const pendingTx = await Transaction.findOne({ providerReference: reference, status: 'pending' });
            if (!pendingTx) {
                return reply.code(200).send('Pending transaction record not found');
            }

            const wallet = await Wallet.findOne({ user: pendingTx.user });
            if (!wallet) return reply.code(200).send('Wallet not found');

            // --- CENTRAL FEE ENGINE: Ignore Gateway Gross-up ---
            // Credit EXACT principal requested originally, preventing inflation
            const creditAmount = pendingTx.amount;
            const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
            
            wallet.availableBalance = String(currentAvail + creditAmount);
            wallet.balance = String(parseFloat(wallet.balance?.toString() || '0') + creditAmount);
            await wallet.save();

            pendingTx.status = 'success';
            pendingTx.balanceBefore = String(currentAvail);
            pendingTx.balanceAfter = wallet.availableBalance;
            await pendingTx.save();

            if (request.server && request.server.io) {
                request.server.io.to(`user:${pendingTx.user}`).emit('wallet:update', { balance: wallet.availableBalance });
                request.server.io.to(`user:${pendingTx.user}`).emit('notification', { 
                    type: 'success', 
                    title: 'Deposit Successful', 
                    message: `Your wallet has been funded with ₦${creditAmount.toLocaleString()}` 
                });
            }
        }

        reply.code(200).send('Webhook Processed');

    } catch (error) {
        console.error('Webhook Error:', error);
        reply.code(500).send('Internal Server Error');
    }
}

module.exports = {
  getWallet,
  fundWallet,
  verifyFunding,
  withdraw,
  transfer,
  setPin,
  resolveBankAccount,
  handlePaystackWebhook
};
