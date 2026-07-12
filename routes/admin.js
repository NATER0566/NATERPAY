const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const { generateTransactionReference } = require('../utils/auth');
const axios = require('axios'); 

// ============================================================================
// USER & SYSTEM MANAGEMENT
// ============================================================================

async function getUsers(request, reply) {
  try {
    const { page = 1, limit = 50, search, role, status } = request.query;
    const query = {};
    if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }, { phoneNumber: { $regex: search, $options: 'i' } }];
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
    if (typeof isSuspended === 'boolean') { user.isSuspended = isSuspended; user.suspensionReason = suspensionReason; user.suspendedAt = isSuspended ? new Date() : null; }
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
// REAL WITHDRAWAL MANAGEMENT 
// ============================================================================

/** 
 * Fetch all pending withdrawals with real user and bank data 
 */
async function getPendingWithdrawals(request, reply) {
    try {
        const pendingWithdrawals = await Transaction.find({ type: 'withdrawal', status: 'pending' })
            .populate('user', 'name email phoneNumber') 
            .sort({ createdAt: -1 });

        reply.send({ success: true, pendingWithdrawals });
    } catch (error) {
        console.error('Admin Fetch Withdrawals Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to fetch pending withdrawals.' });
    }
}

/** 
 * Process a real withdrawal (Approve or Reject)
 */
async function processWithdrawal(request, reply) {
    try {
        const { id, action } = request.params; 
        const transaction = await Transaction.findById(id).populate('user', 'name email');
        
        if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
            return reply.status(400).send({ success: false, message: 'Invalid or non-pending withdrawal.' });
        }

        if (action === 'approve') {
            // Money was already deducted on request. Marking as success means you paid them.
            transaction.status = 'success';
            await transaction.save();

            if (request.server && request.server.io) {
                request.server.io.to(`user:${transaction.user._id}`).emit('notification', { 
                    title: 'Withdrawal Approved', message: 'Your funds have been sent to your bank account!' 
                });
            }
            return reply.send({ success: true, message: 'Withdrawal approved and marked as success.' });

        } else if (action === 'reject') {
            // Refund the money back to the user since you are not paying them
            const wallet = await Wallet.findOne({ user: transaction.user._id });
            if (!wallet) return reply.status(404).send({ success: false, message: 'User wallet not found for refund.' });

            const refundAmount = parseFloat(transaction.amount.toString());
            const refundFee = parseFloat(transaction.fee.toString());
            const totalRefund = refundAmount + refundFee; 

            const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
            const currentTotal = parseFloat(wallet.balance?.toString() || '0');

            wallet.availableBalance = String(currentAvail + totalRefund);
            wallet.balance = String(currentTotal + totalRefund);
            await wallet.save();

            transaction.status = 'failed';
            transaction.metadata = transaction.metadata || new Map();
            transaction.metadata.set('failureReason', 'Rejected by Administrator');
            transaction.balanceAfter = wallet.availableBalance; 
            await transaction.save();

            if (request.server && request.server.io) {
                request.server.io.to(`user:${transaction.user._id}`).emit('wallet:update', { balance: wallet.availableBalance });
                request.server.io.to(`user:${transaction.user._id}`).emit('notification', { 
                    title: 'Withdrawal Rejected', message: 'Your withdrawal was declined and funds refunded.' 
                });
            }

            return reply.send({ success: true, message: 'Withdrawal rejected. Funds successfully refunded to user.' });
        } else {
            return reply.status(400).send({ success: false, message: 'Invalid action.' });
        }
    } catch (error) {
        console.error('Admin Process Withdrawal Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process withdrawal.' });
    }
}

// ============================================================================
// REAL-WORLD PAYSTACK KYC VERIFICATION
// ============================================================================

async function getPendingKYC(request, reply) {
    try {
        const pendingKYC = await KYC.find({ status: 'under_review' })
            .populate('user', 'name email phoneNumber')
            .sort({ createdAt: 1 });
            
        reply.send({ success: true, kycRequests: pendingKYC });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to fetch pending KYC requests' });
    }
}

/** 
 * Ping Paystack API to fetch REAL details of the provided BVN
 */
async function verifyRealWorldKYC(request, reply) {
    try {
        const { kycId } = request.params;
        const kycRecord = await KYC.findById(kycId).populate('user', 'name');
        
        if (!kycRecord) return reply.status(404).send({ success: false, message: 'KYC record not found' });
        if (!kycRecord.bvn) return reply.status(400).send({ success: false, message: 'No BVN provided by user to verify.' });

        // Ping Paystack's Real BVN Resolution API using your environment variable
        const paystackResponse = await axios.get(`https://api.paystack.co/bank/resolve_bvn/${kycRecord.bvn}`, {
            headers: { 
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` 
            }
        });

        const paystackData = paystackResponse.data.data;

        // Return Paystack's data back to your React/Frontend admin dashboard
        reply.send({ 
            success: true, 
            message: 'Paystack verification complete',
            systemName: kycRecord.user.name, 
            paystackDetails: {
                firstName: paystackData.first_name,
                lastName: paystackData.last_name,
                dob: paystackData.formatted_dob,
                phone: paystackData.mobile
            }
        });

    } catch (error) {
        console.error('Paystack API Error:', error.response?.data || error.message);
        
        // Handle Paystack's specific error messages gracefully
        const errorMessage = error.response?.data?.message || 'Failed to communicate with Paystack API.';
        reply.status(400).send({ success: false, message: errorMessage });
    }
}

async function approveKYC(request, reply) {
    try {
        const { kycId } = request.params;
        const kyc = await KYC.findById(kycId);
        if (!kyc) return reply.status(404).send({ success: false, message: 'KYC not found' });

        kyc.status = 'approved';
        await kyc.save();

        const user = await User.findById(kyc.user);
        if (user) {
            user.kycLevel = 2; // Elevate user's privileges 
            await user.save();
            if (request.server && request.server.io) {
                request.server.io.to(`user:${user._id}`).emit('notification', { title: 'KYC Approved', message: 'Your account is now fully verified!' });
            }
        }
        
        reply.send({ success: true, message: 'KYC approved successfully' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Server error during KYC approval' });
    }
}

async function rejectKYC(request, reply) {
    try {
        const { kycId } = request.params;
        const { reason } = request.body;
        
        const kyc = await KYC.findById(kycId);
        if (!kyc) return reply.status(404).send({ success: false, message: 'KYC not found' });

        kyc.status = 'rejected';
        kyc.rejectionReason = reason || 'Your provided details could not be verified.';
        await kyc.save();

        if (request.server && request.server.io) {
            request.server.io.to(`user:${kyc.user}`).emit('notification', { title: 'KYC Rejected', message: `Reason: ${kyc.rejectionReason}` });
        }

        reply.send({ success: true, message: 'KYC rejected' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Server error during KYC rejection' });
    }
}

// ============================================================================
// ADMIN UTILITIES
// ============================================================================

async function updateUserBalance(request, reply) {
    try {
        const { id } = request.params;
        const { action, amount, reason } = request.body;

        if (!amount || amount <= 0 || !reason) return reply.status(400).send({ success: false, message: 'Valid amount and reason are required' });

        const wallet = await Wallet.findOne({ user: id });
        if (!wallet) return reply.status(404).send({ success: false, message: 'User wallet not found' });

        const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
        const currentLedger = parseFloat(wallet.balance?.toString() || '0');
        const amountFloat = parseFloat(amount);

        if (action === 'credit') {
            wallet.availableBalance = String(currentAvail + amountFloat);
            wallet.balance = String(currentLedger + amountFloat);
        } else if (action === 'debit') {
            if (currentAvail < amountFloat) return reply.status(400).send({ success: false, message: 'Insufficient balance' });
            wallet.availableBalance = String(currentAvail - amountFloat);
            wallet.balance = String(currentLedger - amountFloat);
        }

        await wallet.save();

        const adminTx = new Transaction({
            user: id, type: 'admin_adjustment', description: `Admin ${action.toUpperCase()}: ${reason}`, amount: amountFloat,
            fee: 0, balanceBefore: String(currentAvail), balanceAfter: wallet.availableBalance,
            status: 'success', provider: 'internal', providerReference: `ADM-${Date.now()}`
        });
        await adminTx.save();

        if (request.server && request.server.io) request.server.io.to(`user:${id}`).emit('wallet:update', { balance: wallet.availableBalance });
        reply.send({ success: true, message: `Wallet ${action}ed successfully` });
    } catch (error) {
        console.error('Admin balance update error:', error);
        reply.status(500).send({ success: false, message: 'Failed to update ledger balance' });
    }
}

async function verifyTransaction(request, reply) {
    try {
        const { transactionId } = request.body;
        const tx = await Transaction.findById(transactionId);
        
        if (!tx) return reply.status(404).send({ success: false, message: 'Transaction not found' });
        if (tx.status === 'success') return reply.status(400).send({ success: false, message: 'Transaction is already verified' });

        const txAmount = parseFloat(tx.amount?.toString() || '0');

        if (tx.type === 'funding' || tx.type === 'wallet_fund') {
            const wallet = await Wallet.findOne({ user: tx.user });
            if (wallet) {
                const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
                const currentLedger = parseFloat(wallet.balance?.toString() || '0');
                wallet.availableBalance = String(currentAvail + txAmount);
                wallet.balance = String(currentLedger + txAmount);
                await wallet.save();
                tx.balanceAfter = wallet.availableBalance;
                
                if (request.server && request.server.io) request.server.io.to(`user:${tx.user}`).emit('wallet:update', { balance: wallet.availableBalance });
            }
        }

        tx.status = 'success';
        await tx.save();

        reply.send({ success: true, message: 'Transaction force-verified successfully' });
    } catch (error) {
        console.error('Admin force verify error:', error);
        reply.status(500).send({ success: false, message: 'Failed to verify transaction' });
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
    } catch (error) {
        console.error('Send push notification error:', error);
        reply.status(500).send({ success: false, message: 'Failed to transmit notification' });
    }
}

// Support ticket stubs
async function getSupportTickets(request, reply) { reply.send({ success: true, tickets: [] }); }
async function assignTicket(request, reply) { reply.send({ success: true, message: 'Assigned' }); }
async function resolveTicket(request, reply) { reply.send({ success: true, message: 'Resolved' }); }

module.exports = {
  getUsers, getUser, updateUser, getTransactions, getAnalytics, 
  getSupportTickets, assignTicket, resolveTicket,
  updateUserBalance, verifyTransaction, sendPushNotification,
  getPendingWithdrawals, processWithdrawal, 
  getPendingKYC, verifyRealWorldKYC, approveKYC, rejectKYC
};
