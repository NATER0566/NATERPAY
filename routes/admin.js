const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const KYC = require('../models/KYC');
const SupportTicket = require('../models/SupportTicket');
const Analytics = require('../models/Analytics');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');

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
    
    const users = await User.find(query)
      .select('-password -withdrawalPin -otp')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
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
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch users'
    });
  }
}

/**
 * Get single user (admin)
 */
async function getUser(request, reply) {
  try {
    const { id } = request.params;
    
    const user = await User.findById(id).select('-password -withdrawalPin -otp');
    
    if (!user) {
      return reply.status(404).send({
        success: false,
        message: 'User not found'
      });
    }
    
    const wallet = await Wallet.findByUser(user._id);
    const kyc = await KYC.findByUser(user._id);
    const recentTransactions = await Transaction.findByUser(user._id, { limit: 10 });
    
    reply.send({
      success: true,
      user,
      wallet,
      kyc,
      recentTransactions
    });
  } catch (error) {
    console.error('Get user error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch user'
    });
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
    
    if (!user) {
      return reply.status(404).send({
        success: false,
        message: 'User not found'
      });
    }
    
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
      performedBy: request.user._id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    reply.send({
      success: true,
      message: 'User updated successfully',
      user
    });
  } catch (error) {
    console.error('Update user error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update user'
    });
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
      .limit(parseInt(limit));
    
    const total = await Transaction.countDocuments(query);
    
    reply.send({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch transactions'
    });
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
    
    reply.send({
      success: true,
      dailyAnalytics,
      aggregatedStats: aggregatedStats[0] || {},
      summary: {
        totalUsers: userCount,
        totalTransactions: transactionCount,
        pendingKYC,
        openTickets
      }
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch analytics'
    });
  }
}

/**
 * Get pending KYC requests (admin)
 */
async function getPendingKYC(request, reply) {
  try {
    const pendingKYC = await KYC.findPending();
    
    reply.send({
      success: true,
      kycRequests: pendingKYC
    });
  } catch (error) {
    console.error('Get pending KYC error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch pending KYC requests'
    });
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
    
    if (!kyc) {
      return reply.status(404).send({
        success: false,
        message: 'KYC record not found'
      });
    }
    
    const user = await User.findById(kyc.user);
    if (!user) {
      return reply.status(404).send({
        success: false,
        message: 'User not found'
      });
    }
    
    if (level === 1) {
      await kyc.approveLevel1(request.user._id);
      user.kycLevel = Math.max(user.kycLevel, 1);
    } else if (level === 2) {
      await kyc.approveLevel2(request.user._id);
      user.kycLevel = Math.max(user.kycLevel, 2);
    } else if (level === 3) {
      await kyc.approveLevel3(request.user._id);
      user.kycLevel = 3;
    }
    
    await user.save();
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'kyc_approve',
      description: `Admin approved Level ${level} KYC for ${user.email}`,
      details: { userId: user._id, level },
      performedBy: request.user._id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await Notification.create({
      user: user._id,
      title: 'KYC Approved',
      message: `Your Level ${level} KYC has been approved`,
      type: 'kyc',
      priority: 'high'
    });
    
    reply.send({
      success: true,
      message: 'KYC approved successfully'
    });
  } catch (error) {
    console.error('Approve KYC error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to approve KYC'
    });
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
    
    if (!kyc) {
      return reply.status(404).send({
        success: false,
        message: 'KYC record not found'
      });
    }
    
    await kyc.reject(reason);
    if (level) await kyc.resetLevel(level);
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'kyc_reject',
      description: `Admin rejected KYC`,
      details: { kycId: kyc._id, reason, level },
      performedBy: request.user._id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    const user = await User.findById(kyc.user);
    if (user) {
      await Notification.create({
        user: user._id,
        title: 'KYC Rejected',
        message: `Your KYC has been rejected: ${reason}`,
        type: 'kyc',
        priority: 'high'
      });
    }
    
    reply.send({
      success: true,
      message: 'KYC rejected successfully'
    });
  } catch (error) {
    console.error('Reject KYC error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to reject KYC'
    });
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
      .populate('assignedTo', 'name email')
      .sort({ priority: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await SupportTicket.countDocuments(query);
    
    reply.send({
      success: true,
      tickets,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get support tickets error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch support tickets'
    });
  }
}

/**
 * Assign ticket to admin (admin)
 */
async function assignTicket(request, reply) {
  try {
    const { id } = request.params;
    
    const ticket = await SupportTicket.findById(id);
    
    if (!ticket) {
      return reply.status(404).send({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    await ticket.assignTo(request.user._id);
    
    await Notification.create({
      user: ticket.user,
      title: 'Support Ticket Assigned',
      message: `Your support ticket ${ticket.ticketId} has been assigned to an agent`,
      type: 'support',
      priority: 'medium'
    });
    
    reply.send({
      success: true,
      message: 'Ticket assigned successfully'
    });
  } catch (error) {
    console.error('Assign ticket error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to assign ticket'
    });
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
    
    if (!ticket) {
      return reply.status(404).send({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    await ticket.resolve(resolution, request.user._id);
    
    await Notification.create({
      user: ticket.user,
      title: 'Support Ticket Resolved',
      message: `Your support ticket ${ticket.ticketId} has been resolved`,
      type: 'support',
      priority: 'high'
    });
    
    reply.send({
      success: true,
      message: 'Ticket resolved successfully'
    });
  } catch (error) {
    console.error('Resolve ticket error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to resolve ticket'
    });
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
  resolveTicket
};
