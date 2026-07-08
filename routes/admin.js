const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const SupportTicket = require('../models/SupportTicket');
const Analytics = require('../models/Analytics');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');
const { generateTransactionReference } = require('../utils/auth');

/**
 * Get all users (admin)
 */
async function getUsers(request, reply) {
  try {
    const { page = 1, limit = 50, search, role, status } = request.query;
    
    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phoneNumber: { $regex: search, $options: 'i' } }
      ];
    }
    if (role) query.role = role;
    if (status === 'active') query.isActive = true;
    if (status === 'inactive') query.isActive = false;
    if (status === 'suspended') query.isSuspended = true;
    
    // Fetch users and their wallet balances to display in the ledger
    const users = await User.find(query)
      .select('-password -withdrawalPin -otp')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();
      
    // Attach wallet balance for the admin table securely
    for (let user of users) {
        const wallet = await Wallet.findOne({ user: user._id });
        user.walletBalance = wallet ? wallet.availableBalance.toString() : 0;
    }
    
    const total = await User.countDocuments(query);
    
    reply.send({
      success: true,
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch users' });
  }
}

/**
 * Get single user (admin)
 */
async function getUser(request, reply) {
  try {
    const { id } = request.params;
    const user = await User.findById(id).select('-password -withdrawalPin -otp');
    
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
    
    const wallet = await Wallet.findByUser(user._id);
    const kyc = await KYC.findByUser(user._id);
    const recentTransactions = await Transaction.findByUser(user._id, { limit: 10 });
    
    reply.send({ success: true, user, wallet, kyc, recentTransactions });
  } catch (error) {
    console.error('Get user error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch user' });
  }
}

/**
 * Update user (admin)
 */
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
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'admin_action',
      description: `Admin updated user ${user.email}`,
      details: { userId: user._id, changes: request.body },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.send({ success: true, message: 'User updated successfully', user });
  } catch (error) {
    console.error('Update user error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update user' });
  }
}

/**
 * Get all transactions (admin)
 */
async function getTransactions(request, reply) {
  try {
    const { page = 1, limit = 50, type, status, startDate, endDate } = request.query;
    
    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const transactions = await Transaction.find(query)
      .populate('user', 'name email phoneNumber')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();
      
    // Format user data for the frontend
    const formattedTx = transactions.map(tx => ({
        ...tx,
        userEmail: tx.user ? tx.user.email : 'Unknown User'
    }));
    
    const total = await Transaction.countDocuments(query);
    
    reply.send({
      success: true,
      transactions: formattedTx,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch transactions' });
  }
}

/**
 * Get analytics (admin)
 */
async function getAnalytics(request, reply) {
  try {
    const { days = 30 } = request.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const dailyAnalytics = await Analytics.findByDateRange(startDate, new Date());
    const aggregatedStats = await Analytics.getAggregatedStats(startDate, new Date());
    
    const userCount = await User.countDocuments({ isActive: true });
    const transactionCount = await Transaction.countDocuments({ status: 'success' });
    const pendingKYC = await KYC.countDocuments({ status: 'under_review' });
    const openTickets = await SupportTicket.countDocuments({ status: 'open' });
    
    // Calculate total vault balance safely using Decimal128 parsers
    const wallets = await Wallet.find({});
    const totalVaultBalance = wallets.reduce((acc, w) => acc + parseFloat(w.availableBalance?.toString() || '0'), 0);
    
    reply.send({
      success: true,
      dailyAnalytics,
      aggregatedStats: aggregatedStats[0] || {},
      summary: {
        totalUsers: userCount,
        totalTransactions: transactionCount,
        pendingKYC,
        openTickets,
        totalVaultBalance
      }
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch analytics' });
  }
}

/**
 * Get pending KYC requests (admin)
 */
async function getPendingKYC(request, reply) {
  try {
    const pendingKYC = await KYC.findPending();
    reply.send({ success: true, kycRequests: pendingKYC });
  } catch (error) {
    console.error('Get pending KYC error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch pending KYC requests' });
  }
}

/**
 * Approve KYC (admin)
 */
async function approveKYC(request, reply) {
  try {
    const { id } = request.params;
    const { level } = request.body;
    
    const kyc = await KYC.findById(id);
    if (!kyc) return reply.status(404).send({ success: false, message: 'KYC record not found' });
    
    const user = await User.findById(kyc.user);
    if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
    
    if (level === 1) { await kyc.approveLevel1(request.user._id); user.kycLevel = Math.max(user.kycLevel, 1); }
    else if (level === 2) { await kyc.approveLevel2(request.user._id); user.kycLevel = Math.max(user.kycLevel, 2); }
    else if (level === 3) { await kyc.approveLevel3(request.user._id); user.kycLevel = 3; }
    
    await user.save();
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'kyc_approve',
      description: `Admin approved Level ${level} KYC for ${user.email}`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await Notification.create({ user: user._id, title: 'KYC Approved', message: `Your Level ${level} KYC has been approved`, type: 'kyc', priority: 'high' });
    
    reply.send({ success: true, message: 'KYC approved successfully' });
  } catch (error) {
    console.error('Approve KYC error:', error);
    reply.status(500).send({ success: false, message: 'Failed to approve KYC' });
  }
}

/**
 * Reject KYC (admin)
 */
async function rejectKYC(request, reply) {
  try {
    const { id } = request.params;
    const { reason, level } = request.body;
    
    const kyc = await KYC.findById(id);
    if (!kyc) return reply.status(404).send({ success: false, message: 'KYC record not found' });
    
    await kyc.reject(reason);
    if (level) await kyc.resetLevel(level);
    
    const user = await User.findById(kyc.user);
    if (user) {
      await Notification.create({ user: user._id, title: 'KYC Rejected', message: `Your KYC has been rejected: ${reason}`, type: 'kyc', priority: 'high' });
    }
    
    reply.send({ success: true, message: 'KYC rejected successfully' });
  } catch (error) {
    console.error('Reject KYC error:', error);
    reply.status(500).send({ success: false, message: 'Failed to reject KYC' });
  }
}

/**
 * Get support tickets (admin)
 */
async function getSupportTickets(request, reply) {
  try {
    const { status, priority, page = 1, limit = 50 } = request.query;
    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    
    const tickets = await SupportTicket.find(query)
      .populate('user', 'name email phoneNumber')
      .sort({ priority: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await SupportTicket.countDocuments(query);
    reply.send({ success: true, tickets, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('Get support tickets error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch support tickets' });
  }
}

/**
 * Assign ticket to admin (admin)
 */
async function assignTicket(request, reply) {
  try {
    const { id } = request.params;
    const ticket = await SupportTicket.findById(id);
    if (!ticket) return reply.status(404).send({ success: false, message: 'Ticket not found' });
    
    await ticket.assignTo(request.user._id);
    reply.send({ success: true, message: 'Ticket assigned successfully' });
  } catch (error) {
    console.error('Assign ticket error:', error);
    reply.status(500).send({ success: false, message: 'Failed to assign ticket' });
  }
}

/**
 * Resolve ticket (admin)
 */
async function resolveTicket(request, reply) {
  try {
    const { id } = request.params;
    const { resolution } = request.body;
    const ticket = await SupportTicket.findById(id);
    if (!ticket) return reply.status(404).send({ success: false, message: 'Ticket not found' });
    
    await ticket.resolve(resolution, request.user._id);
    reply.send({ success: true, message: 'Ticket resolved successfully' });
  } catch (error) {
    console.error('Resolve ticket error:', error);
    reply.status(500).send({ success: false, message: 'Failed to resolve ticket' });
  }
}

// ============================================================================
// NEW ENTERPRISE ADMIN FEATURES
// ============================================================================

/**
 * Admin: Update User Ledger Balance Manually (Credit/Debit)
 * SECURED: Uses Decimal128 parsing to prevent NaN errors
 */
async function updateUserBalance(request, reply) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = request.params;
        const { action, amount, reason } = request.body;

        if (!amount || amount <= 0 || !reason) {
            await session.abortTransaction();
            return reply.status(400).send({ success: false, message: 'Valid amount and reason are required' });
        }

        const wallet = await Wallet.findOne({ user: id }).session(session);
        if (!wallet) {
            await session.abortTransaction();
            return reply.status(404).send({ success: false, message: 'User wallet not found' });
        }

        // Securely parse Decimal128
        const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
        const currentLedger = parseFloat(wallet.balance?.toString() || '0');
        const amountFloat = parseFloat(amount);

        if (action === 'credit') {
            wallet.availableBalance = (currentAvail + amountFloat).toString();
            wallet.balance = (currentLedger + amountFloat).toString();
        } else if (action === 'debit') {
            if (currentAvail < amountFloat) {
                await session.abortTransaction();
                return reply.status(400).send({ success: false, message: 'Insufficient balance to deduct that amount' });
            }
            wallet.availableBalance = (currentAvail - amountFloat).toString();
            wallet.balance = (currentLedger - amountFloat).toString();
        } else {
            await session.abortTransaction();
            return reply.status(400).send({ success: false, message: 'Invalid action type' });
        }

        await wallet.save({ session });

        const adminTx = new Transaction({
            user: id,
            type: 'admin_adjustment',
            description: `Admin ${action.toUpperCase()}: ${reason}`,
            amount: amountFloat,
            fee: 0,
            balanceBefore: currentAvail.toString(),
            balanceAfter: wallet.availableBalance.toString(),
            status: 'success',
            provider: 'internal',
            reference: `ADM-${generateTransactionReference()}`
        });
        await adminTx.save({ session });

        await session.commitTransaction();
        session.endSession();

        if (request.server.io) {
            request.server.io.to(`user:${id}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
        }

        reply.send({ success: true, message: `Wallet ${action}ed successfully`, newBalance: wallet.availableBalance.toString() });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Admin balance update error:', error);
        reply.status(500).send({ success: false, message: 'Failed to update ledger balance' });
    }
}

/**
 * Admin: Force Verify Stuck Transaction
 * SECURED: Uses Decimal128 parsing to prevent NaN errors
 */
async function verifyTransaction(request, reply) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { transactionId } = request.body;
        
        const tx = await Transaction.findById(transactionId).session(session);
        if (!tx) {
            await session.abortTransaction();
            return reply.status(404).send({ success: false, message: 'Transaction not found' });
        }

        if (tx.status === 'success') {
            await session.abortTransaction();
            return reply.status(400).send({ success: false, message: 'Transaction is already verified and successful' });
        }

        // Get exact amount from Decimal128 format safely
        const txAmount = parseFloat(tx.amount?.$numberDecimal || tx.amount?.toString() || '0');

        if (tx.type === 'funding' || tx.type === 'wallet_fund') {
            const wallet = await Wallet.findOne({ user: tx.user }).session(session);
            if (wallet) {
                const currentAvail = parseFloat(wallet.availableBalance?.toString() || '0');
                const currentLedger = parseFloat(wallet.balance?.toString() || '0');
                
                wallet.availableBalance = (currentAvail + txAmount).toString();
                wallet.balance = (currentLedger + txAmount).toString();
                await wallet.save({ session });
                
                tx.balanceAfter = wallet.availableBalance.toString();
                
                if (request.server.io) {
                    request.server.io.to(`user:${tx.user}`).emit('wallet:update', { balance: wallet.availableBalance.toString() });
                }
            }
        }

        tx.status = 'success';
        await tx.save({ session });

        await AuditLog.logAction({
            user: request.user._id,
            action: 'admin_force_verify',
            description: `Admin force verified transaction ${tx._id}`,
            ipAddress: request.ip
        });

        await session.commitTransaction();
        session.endSession();

        reply.send({ success: true, message: 'Transaction force-verified successfully' });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Admin force verify error:', error);
        reply.status(500).send({ success: false, message: 'Failed to verify transaction' });
    }
}

/**
 * Admin: Send Push Notifications
 * SECURED: Handles multipart/form-data for file uploads gracefully
 */
async function sendPushNotification(request, reply) {
    try {
        // Fastify-multipart nests text fields inside a .value property if attachFieldsToBody is true
        const targetEmail = request.body.targetEmail?.value !== undefined ? request.body.targetEmail.value : request.body.targetEmail;
        const title = request.body.title?.value !== undefined ? request.body.title.value : request.body.title;
        const message = request.body.message?.value !== undefined ? request.body.message.value : request.body.message;
        const type = request.body.type?.value !== undefined ? request.body.type.value : (request.body.type || 'info');
        
        // Optional file handling for future expansion
        // const attachedFile = request.body.file;

        if (targetEmail === 'ALL' || !targetEmail) {
            // Broadcast to everyone
            if (request.server.io) {
                request.server.io.emit('notification', { title, message, type });
            }
            return reply.send({ success: true, message: 'Broadcast transmitted to all active sessions' });
        }

        // Target specific user
        const user = await User.findOne({ email: targetEmail });
        if (!user) return reply.status(404).send({ success: false, message: 'Target user not found' });

        await Notification.create({
            user: user._id,
            title,
            message,
            type: 'system',
            priority: 'high'
        });

        // Emit to specific socket room
        if (request.server.io) {
            request.server.io.to(`user:${user._id}`).emit('notification', { title, message, type });
        }

        reply.send({ success: true, message: 'Notification transmitted to user' });
    } catch (error) {
        console.error('Send push notification error:', error);
        reply.status(500).send({ success: false, message: 'Failed to transmit notification' });
    }
}

module.exports = {
  getUsers,
  getUser,
  updateUser,
  getTransactions,
  getAnalytics,
  getPendingKYC,
  approveKYC,
  rejectKYC,
  getSupportTickets,
  assignTicket,
  resolveTicket,
  // New Additions
  updateUserBalance,
  verifyTransaction,
  sendPushNotification
};
