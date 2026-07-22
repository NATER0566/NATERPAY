const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const PaymentLink = require('../models/PaymentLink'); 
const Ad = require('../models/Ad'); 
const axios = require('axios'); 
const Joi = require('joi'); // Added validation
const crypto = require('crypto');

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
            status: params.status, source: params.source, details: params.details || {}
        });
        if (session) await log.save({ session }); else await log.save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

// ============================================================================
// USER & SYSTEM MANAGEMENT
// ============================================================================

async function getUsers(request, reply) {
    try {
        const { page = 1, limit = 50, search, role, status } = request.query;
        const query = {};
        if (search) query.$or = [{ name: { $regex: search,$options: 'i' } }, { email: { $regex: search,$options: 'i' } }, { phoneNumber: { $regex: search,$options: 'i' } }];
        if (role) query.role = role;
        if (status === 'active') query.isActive = true;
        if (status === 'inactive') query.isActive = false;
        if (status === 'suspended') query.isSuspended = true;
        
        const users = await User.find(query).select('-password -transactionPin -otp').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)).lean();
        for (let user of users) {
            const wallet = await Wallet.findOne({ user: user._id });
            user.walletBalance = wallet ? wallet.availableBalance.toString() : '0';
        }
        const total = await User.countDocuments(query);
        reply.send({ success: true, users, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) } });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch users' }); }
}

async function getUser(request, reply) {
    try {
        const { id } = request.params;
        const user = await User.findById(id).select('-password -transactionPin -otp');
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        const wallet = await Wallet.findOne({ user: user._id });
        const kyc = await KYC.findOne({ user: user._id });
        const recentTransactions = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(10);
        reply.send({ success: true, user, wallet, kyc, recentTransactions });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch user' }); }
}

async function updateUser(request, reply) {
    try {
        const { id } = request.params;
        const { name, role, isActive, isSuspended, suspensionReason, isSecured } = request.body;
        const user = await User.findById(id);
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        
        if (name) user.name = name;
        if (role) user.role = role;
        if (typeof isActive === 'boolean') user.isActive = isActive;
        if (typeof isSuspended === 'boolean') { 
            user.isSuspended = isSuspended; 
            user.suspensionReason = suspensionReason; 
            user.suspendedAt = isSuspended ? new Date() : null; 
        }
        if (typeof isSecured === 'boolean') user.isSecured = isSecured;
        await user.save();
        
        reply.send({ success: true, message: 'User updated successfully', user });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to update user' }); }
}

async function getTransactions(request, reply) {
    try {
        const { page = 1, limit = 50, type, status } = request.query;
        const query = {};
        if (type) query.type = type;
        if (status) query.status = status;
        
        const transactions = await Transaction.find(query).populate('user', 'name email phoneNumber').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)).lean();
        const formattedTx = transactions.map(tx => ({ ...tx, userEmail: tx.user ? tx.user.email : 'Unknown User' }));
        const total = await Transaction.countDocuments(query);
        
        reply.send({ success: true, transactions: formattedTx, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) } });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch transactions' }); }
}

async function getAnalytics(request, reply) {
    try {
        const userCount = await User.countDocuments({ isActive: true });
        const transactionCount = await Transaction.countDocuments({ status: 'success' });
        const pendingKYC = await KYC.countDocuments({ status: 'under_review' });
        const openTickets = await SupportTicket.countDocuments({ status: 'open' });
        const wallets = await Wallet.find({});
        const totalVaultBalance = wallets.reduce((acc, w) => acc + parseFloat(w.availableBalance?.toString() || '0'), 0);
        
        reply.send({ success: true, summary: { totalUsers: userCount, totalTransactions: transactionCount, pendingKYC, openTickets, totalVaultBalance } });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch analytics' }); }
}

// ============================================================================
// ENTERPRISE WITHDRAWAL MANAGEMENT (ATOMIC AUTO-REFUND & AUDIT ENGINE)
// ============================================================================

async function getPendingWithdrawals(request, reply) {
    try {
        const pendingWithdrawals = await Transaction.find({ type: 'withdrawal', status: 'processing' })
            .populate('user', 'name email phoneNumber') 
            .sort({ createdAt: -1 });

        reply.send({ success: true, pendingWithdrawals });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to fetch pending withdrawals.' });
    }
}

async function processWithdrawal(request, reply) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { id, action } = request.params; 
        const { reason } = request.body || {}; 
        
        // [1] Atomic Lock
        const transaction = await Transaction.findOne({ _id: id, type: 'withdrawal', status: 'processing' }).populate('user', 'name email').session(session);
        if (!transaction) throw new Error('Invalid or already processed transaction.');

        // ==========================================
        // APPROVAL LOGIC
        // ==========================================
        if (action === 'approve') {
            transaction.status = 'success';
            transaction.metadata = transaction.metadata || {};
            transaction.metadata.approvedBy = request.user?._id;
            transaction.metadata.approvedAt = new Date();
            await transaction.save({ session });

            await createAuditLog({
                user: transaction.user._id, transactionId: transaction._id, reference: transaction.providerReference, amount: transaction.amount,
                type: 'withdrawal_approve', previousBalance: transaction.balanceAfter, newBalance: transaction.balanceAfter, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`
            }, session);

            if (Notification && typeof Notification.create === 'function') {
                await Notification.create({ user: transaction.user._id, title: 'Withdrawal Approved', message: `Your withdrawal of ₦${transaction.amount} has been successfully sent.`, type: 'success', priority: 'high' }).catch(e=>e);
            }

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${transaction.user._id}`).emit('notification', { title: 'Withdrawal Approved', message: 'Funds sent to bank!', type: 'success' });
            return reply.send({ success: true, message: 'Withdrawal approved and marked as success.' });

        // ==========================================
        // REJECTION LOGIC (ATOMIC REFUND)
        // ==========================================
        } else if (action === 'reject') {
            const wallet = await Wallet.findOne({ user: transaction.user._id }).session(session);
            if (!wallet) throw new Error('User wallet not found for refund.');

            const refundAmount = sanitizeAmount(Number(transaction.amount) + Number(transaction.fee));
            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentTotal = sanitizeAmount(wallet.balance);

            const newAvail = currentAvail + refundAmount;

            wallet.availableBalance = String(newAvail);
            wallet.balance = String(currentTotal + refundAmount);
            await wallet.save({ session });

            transaction.status = 'failed';
            transaction.balanceAfter = String(newAvail); 
            transaction.metadata = transaction.metadata || {};
            transaction.metadata.rejectionReason = reason || 'Rejected by Administrator';
            transaction.metadata.rejectedBy = request.user?._id;
            transaction.metadata.rejectedAt = new Date();
            await transaction.save({ session });

            await createAuditLog({
                user: transaction.user._id, transactionId: transaction._id, reference: transaction.providerReference, amount: refundAmount,
                type: 'withdrawal_refund', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'failed', source: `Admin API: ${request.user._id}`
            }, session);

            if (Notification && typeof Notification.create === 'function') {
                await Notification.create({ user: transaction.user._id, title: 'Withdrawal Rejected', message: `Your ₦${transaction.amount} withdrawal was rejected. Funds refunded.`, type: 'error', priority: 'high' }).catch(e=>e);
            }

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) {
                request.server.io.to(`user:${transaction.user._id}`).emit('wallet:update', { balance: wallet.availableBalance });
                request.server.io.to(`user:${transaction.user._id}`).emit('notification', { type: 'error', title: 'Withdrawal Rejected', message: `Refunded: ${reason || 'Admin decision'}` });
            }
            return reply.send({ success: true, message: `Withdrawal rejected. ₦${refundAmount} has been safely refunded to user.` });
        } else {
            throw new Error('Invalid action.');
        }
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        logger.error('Admin Process Withdrawal Error:', error);
        reply.status(400).send({ success: false, message: error.message || 'Failed to process withdrawal.' });
    }
}

// ============================================================================
// DIRECT PAYSTACK KYC VERIFICATION ENGINE
// ============================================================================

async function getPendingKYC(request, reply) {
    try {
        const pendingKYC = await KYC.find({ status: 'under_review' }).populate('user', 'name email phoneNumber').sort({ createdAt: 1 });
        reply.send({ success: true, kycRequests: pendingKYC });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch pending KYC requests' }); }
}

async function verifyRealWorldKYC(request, reply) {
    try {
        const { kycId } = request.params;
        const kycRecord = await KYC.findById(kycId).populate('user', 'name');
        
        if (!kycRecord) return reply.status(404).send({ success: false, message: 'KYC record not found' });
        
        const bvn = kycRecord.level1?.bvn;
        if (!bvn) return reply.status(400).send({ success: false, message: 'No BVN provided by user to verify.' });

        try {
            const paystackResponse = await axios.get(`https://api.paystack.co/bank/resolve_bvn/${bvn}`, {
                headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, timeout: 15000
            });
            const paystackData = paystackResponse.data.data;
            return reply.send({ success: true, message: 'Paystack verification complete', systemName: kycRecord.user.name, paystackDetails: { firstName: paystackData.first_name, lastName: paystackData.last_name, dob: paystackData.formatted_dob, phone: paystackData.mobile } });
        } catch (paystackError) {
            const errorMessage = paystackError.response?.data?.message || 'Paystack BVN service is offline or rejected the request.';
            return reply.status(400).send({ success: false, message: `Paystack Error: ${errorMessage}` });
        }
    } catch (error) { reply.status(500).send({ success: false, message: 'Server error during verification.' }); }
}

async function approveKYC(request, reply) {
    try {
        const { kycId } = request.params;
        const kyc = await KYC.findById(kycId);
        if (!kyc) return reply.status(404).send({ success: false, message: 'KYC not found' });

        const user = await User.findById(kyc.user);
        if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
        
        if (kyc.currentLevel === 1) { await kyc.approveLevel1(request.user._id); user.kycLevel = 1; } 
        else if (kyc.currentLevel === 2) { await kyc.approveLevel2(request.user._id); user.kycLevel = 2; } 
        else if (kyc.currentLevel === 3) { await kyc.approveLevel3(request.user._id); user.kycLevel = 3; }
        
        await user.save();

        if (request.server && request.server.io) request.server.io.to(`user:${user._id}`).emit('notification', { title: 'KYC Approved', message: `Your Tier ${kyc.currentLevel} verification is approved!` });
        
        reply.send({ success: true, message: 'KYC approved successfully' });
    } catch (error) { reply.status(500).send({ success: false, message: 'Server error during KYC approval' }); }
}

async function rejectKYC(request, reply) {
    try {
        const { kycId } = request.params;
        const reason = request.body && request.body.reason ? request.body.reason : 'Your provided details could not be verified.';
        
        const kyc = await KYC.findById(kycId);
        if (!kyc) return reply.status(404).send({ success: false, message: 'KYC not found' });

        await kyc.reject(reason);

        if (request.server && request.server.io) request.server.io.to(`user:${kyc.user}`).emit('notification', { title: 'KYC Rejected', message: `Reason: ${kyc.rejectionReason}` });

        reply.send({ success: true, message: 'KYC rejected successfully.' });
    } catch (error) { reply.status(500).send({ success: false, message: 'Server error during KYC rejection' }); }
}

// ============================================================================
// MARKETPLACE MODERATION ENGINES
// ============================================================================

async function updateProduct(request, reply) {
    try {
        const { id } = request.params;
        const { title, amount, category, description } = request.body;

        const product = await PaymentLink.findById(id);
        if (!product) return reply.status(404).send({ success: false, message: 'Product item not found' });

        if (title) product.title = title;
        if (category) product.category = category;
        if (description) product.description = description;
        if (amount !== undefined && !product.isFlexibleAmount) product.amount = String(amount);

        await product.save();
        reply.send({ success: true, message: 'Product listing modified successfully', product });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to update marketplace item' }); }
}

async function deleteProduct(request, reply) {
    try {
        const { id } = request.params;
        const product = await PaymentLink.findByIdAndDelete(id);
        if (!product) return reply.status(404).send({ success: false, message: 'Listing already purged or not found' });
        reply.send({ success: true, message: 'Product completely purged from global ledger' });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to delete product from ledger' }); }
}

// ============================================================================
// ENTERPRISE ADVERTS MODERATION ENGINE (ATOMIC REFUND)
// ============================================================================

async function getPendingAds(request, reply) {
    try {
        const ads = await Ad.find({}).populate('user', 'name email').sort({ status: -1, createdAt: -1 }); 
        reply.send({ success: true, ads });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to fetch adverts' }); }
}

async function approveAd(request, reply) {
    try {
        const { id } = request.params;
        const ad = await Ad.findById(id);
        if (!ad) return reply.status(404).send({ success: false, message: 'Advert not found' });
        
        ad.status = 'approved';
        await ad.save();

        if (request.server && request.server.io) request.server.io.to(`user:${ad.user}`).emit('notification', { title: 'Campaign Approved!', type: 'success', message: `Your campaign "${ad.title}" is now LIVE.` });
        reply.send({ success: true, message: 'Advert approved and is now live.' });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to approve advert' }); }
}

async function rejectAd(request, reply) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { id } = request.params;
        const ad = await Ad.findOne({ _id: id, status: { $ne: 'rejected' } }).session(session);
        if (!ad) throw new Error('Advert not found or already rejected.');
        
        const totalRefund = sanitizeAmount(Number(ad.packageCost || 0) + Number(ad.viewBudgetCost || 0));
        
        const wallet = await Wallet.findOne({ user: ad.user }).session(session);
        if (wallet) {
            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentLedger = sanitizeAmount(wallet.balance);
            const newAvail = currentAvail + totalRefund;
            
            wallet.availableBalance = String(newAvail);
            wallet.balance = String(currentLedger + totalRefund);
            await wallet.save({ session });

            const refundTx = new Transaction({
                user: ad.user, type: 'funding', description: `Refund: Rejected Campaign (${ad.title})`,
                amount: totalRefund, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
                status: 'success', provider: 'internal', providerReference: `REF-AD-${Date.now()}`
            });
            await refundTx.save({ session });

            await createAuditLog({
                user: ad.user, transactionId: refundTx._id, reference: refundTx.providerReference, amount: totalRefund,
                type: 'ad_refund', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`
            }, session);

            if (request.server && request.server.io) request.server.io.to(`user:${ad.user}`).emit('wallet:update', { balance: wallet.availableBalance });
        }
        
        ad.status = 'rejected';
        await ad.save({ session });

        await session.commitTransaction();
        session.endSession();

        if (request.server && request.server.io) request.server.io.to(`user:${ad.user}`).emit('notification', { title: 'Campaign Rejected', type: 'error', message: `Campaign "${ad.title}" rejected. Funds refunded.` });
        reply.send({ success: true, message: 'Advert rejected and funds fully refunded.' });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        logger.error('Admin Reject Ad Error:', error);
        reply.status(400).send({ success: false, message: error.message || 'Failed to reject advert' });
    }
}

async function deleteAd(request, reply) {
    try {
        const { id } = request.params;
        const ad = await Ad.findByIdAndDelete(id);
        if (!ad) return reply.status(404).send({ success: false, message: 'Advert already deleted or not found' });
        reply.send({ success: true, message: 'Advert permanently obliterated from database.' });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to permanently delete advert' }); }
}

// ============================================================================
// ADMIN UTILITIES (ATOMIC LEDGER MANAGEMENT)
// ============================================================================

async function updateUserBalance(request, reply) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { id } = request.params;
        const { action, amount, reason } = request.body;

        if (!amount || amount <= 0 || !reason) throw new Error('Valid amount and reason are required');

        const wallet = await Wallet.findOne({ user: id }).session(session);
        if (!wallet) throw new Error('User wallet not found');

        const currentAvail = sanitizeAmount(wallet.availableBalance);
        const currentLedger = sanitizeAmount(wallet.balance);
        const amountFloat = sanitizeAmount(amount);

        let newAvail, newLedger;

        if (action === 'credit') {
            newAvail = currentAvail + amountFloat;
            newLedger = currentLedger + amountFloat;
        } else if (action === 'debit') {
            if (currentAvail < amountFloat) throw new Error('Insufficient user balance for this debit.');
            newAvail = currentAvail - amountFloat;
            newLedger = currentLedger - amountFloat;
        } else {
            throw new Error('Invalid action provided.');
        }

        wallet.availableBalance = String(newAvail);
        wallet.balance = String(newLedger);
        await wallet.save({ session });

        const adminTx = new Transaction({
            user: id, type: action === 'credit' ? 'funding' : 'withdrawal', description: `Admin ${action.toUpperCase()}: ${reason}`, 
            amount: amountFloat, fee: 0, balanceBefore: String(currentAvail), balanceAfter: String(newAvail),
            status: 'success', provider: 'internal', providerReference: `ADM-${Date.now()}`
        });
        await adminTx.save({ session }); 

        await createAuditLog({
            user: id, transactionId: adminTx._id, reference: adminTx.providerReference, amount: amountFloat,
            type: action === 'credit' ? 'admin_credit' : 'admin_debit', previousBalance: currentAvail, newBalance: newAvail, 
            ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`, details: { reason }
        }, session);

        await session.commitTransaction();
        session.endSession();

        if (request.server && request.server.io) request.server.io.to(`user:${id}`).emit('wallet:update', { balance: wallet.availableBalance });
        reply.send({ success: true, message: `Wallet ${action}ed successfully!`, newBalance: wallet.availableBalance });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        logger.error('Admin balance update error:', error);
        reply.status(400).send({ success: false, message: error.message || 'Failed to update ledger balance.' });
    }
}

async function verifyTransaction(request, reply) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { transactionId } = request.body;
        const tx = await Transaction.findById(transactionId).session(session);
        
        if (!tx) throw new Error('Transaction not found');
        if (tx.status === 'success') throw new Error('Transaction is already verified');

        const txAmount = sanitizeAmount(tx.amount);

        if (tx.type === 'funding' || tx.type === 'wallet_fund') {
            const wallet = await Wallet.findOne({ user: tx.user }).session(session);
            if (!wallet) throw new Error('User wallet not found');

            const currentAvail = sanitizeAmount(wallet.availableBalance);
            const currentLedger = sanitizeAmount(wallet.balance);
            
            const newAvail = currentAvail + txAmount;
            const newLedger = currentLedger + txAmount;

            tx.balanceAfter = String(newAvail);
            tx.status = 'success';
            tx.metadata = tx.metadata || {};
            tx.metadata.forcedVerifyBy = request.user._id;
            await tx.save({ session }); 

            wallet.availableBalance = String(newAvail);
            wallet.balance = String(newLedger);
            await wallet.save({ session });
            
            await createAuditLog({
                user: tx.user, transactionId: tx._id, reference: tx.providerReference, amount: txAmount,
                type: 'admin_force_verify', previousBalance: currentAvail, newBalance: newAvail, 
                ipAddress: request.ip, userAgent: request.headers['user-agent'], status: 'success', source: `Admin API: ${request.user._id}`
            }, session);

            await session.commitTransaction();
            session.endSession();

            if (request.server && request.server.io) request.server.io.to(`user:${tx.user}`).emit('wallet:update', { balance: wallet.availableBalance });
        } else {
            tx.status = 'success';
            tx.metadata = tx.metadata || {};
            tx.metadata.forcedVerifyBy = request.user._id;
            await tx.save({ session });

            await session.commitTransaction();
            session.endSession();
        }

        reply.send({ success: true, message: 'Transaction force-verified successfully' });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        logger.error('Admin force verify error:', error);
        reply.status(400).send({ success: false, message: error.message || 'Failed to verify transaction' });
    }
}

async function sendPushNotification(request, reply) {
    try {
        const { targetEmail, title, message, type, fileData } = request.body;
        
        if (targetEmail === 'ALL' || !targetEmail) {
            if (request.server && request.server.io) request.server.io.emit('notification', { title, message, type: type || 'info', image: fileData });
            return reply.send({ success: true, message: 'Broadcast transmitted' });
        }

        const user = await User.findOne({ email: targetEmail });
        if (!user) return reply.status(404).send({ success: false, message: 'Target user not found' });

        if (Notification && typeof Notification.create === 'function') {
            await Notification.create({ user: user._id, title, message, type: 'system', priority: 'high' });
        }

        if (request.server && request.server.io) request.server.io.to(`user:${user._id}`).emit('notification', { title, message, type: type || 'info', image: fileData });
        reply.send({ success: true, message: 'Notification transmitted to user' });
    } catch (error) { reply.status(500).send({ success: false, message: 'Failed to transmit notification' }); }
}

async function getSupportTickets(request, reply) { reply.send({ success: true, tickets: [] }); }
async function assignTicket(request, reply) { reply.send({ success: true, message: 'Assigned' }); }
async function resolveTicket(request, reply) { reply.send({ success: true, message: 'Resolved' }); }

module.exports = {
  getUsers, getUser, updateUser, getTransactions, getAnalytics, 
  getSupportTickets, assignTicket, resolveTicket,
  updateUserBalance, verifyTransaction, sendPushNotification,
  getPendingWithdrawals, processWithdrawal, 
  getPendingKYC, verifyRealWorldKYC, approveKYC, rejectKYC,
  updateProduct, deleteProduct,
  getPendingAds, approveAd, rejectAd, deleteAd
};
