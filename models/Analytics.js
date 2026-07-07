const mongoose = require('mongoose');

const analyticsSchema = new mongoose.Schema({
  // Daily analytics
  date: {
    type: Date,
    required: true,
    unique: true,
    index: true
  },
  
  // User metrics
  newUsers: {
    type: Number,
    default: 0
  },
  
  activeUsers: {
    type: Number,
    default: 0
  },
  
  kycVerified: {
    type: Number,
    default: 0
  },
  
  // Transaction metrics
  totalTransactions: {
    type: Number,
    default: 0
  },
  
  successfulTransactions: {
    type: Number,
    default: 0
  },
  
  failedTransactions: {
    type: Number,
    default: 0
  },
  
  totalVolume: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  totalRevenue: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  // VTU metrics
  airtimeTransactions: {
    type: Number,
    default: 0
  },
  
  dataTransactions: {
    type: Number,
    default: 0
  },
  
  electricityTransactions: {
    type: Number,
    default: 0
  },
  
  cableTransactions: {
    type: Number,
    default: 0
  },
  
  // Payment metrics
  fundingTransactions: {
    type: Number,
    default: 0
  },
  
  withdrawalTransactions: {
    type: Number,
    default: 0
  },
  
  // Merchant metrics
  activeMerchants: {
    type: Number,
    default: 0
  },
  
  merchantTransactions: {
    type: Number,
    default: 0
  },
  
  merchantVolume: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  // Referral metrics
  newReferrals: {
    type: Number,
    default: 0
  },
  
  referralBonusPaid: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  // Support metrics
  ticketsOpened: {
    type: Number,
    default: 0
  },
  
  ticketsResolved: {
    type: Number,
    default: 0
  },
  
  avgResponseTime: {
    type: Number,
    default: 0
  },
  
  // Breakdown by type
  transactionBreakdown: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  
  // Breakdown by provider
  providerBreakdown: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  
  // Metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  }
}, {
  timestamps: true
});

// Indexes
analyticsSchema.index({ date: -1 });

// Static methods
analyticsSchema.statics.findByDateRange = function(startDate, endDate) {
  return this.find({
    date: {
      $gte: startDate,
      $lte: endDate
    }
  }).sort({ date: 1 });
};

analyticsSchema.statics.getToday = function() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return this.findOne({ date: today });
};

analyticsSchema.statics.getRecentDays = function(days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  
  return this.find({
    date: { $gte: startDate }
  }).sort({ date: -1 });
};

analyticsSchema.statics.getAggregatedStats = function(startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalNewUsers: { $sum: '$newUsers' },
        totalActiveUsers: { $sum: '$activeUsers' },
        totalKycVerified: { $sum: '$kycVerified' },
        totalTransactions: { $sum: '$totalTransactions' },
        totalSuccessfulTransactions: { $sum: '$successfulTransactions' },
        totalFailedTransactions: { $sum: '$failedTransactions' },
        totalVolume: { $sum: { $toDecimal: '$totalVolume' } },
        totalRevenue: { $sum: { $toDecimal: '$totalRevenue' } },
        totalAirtimeTransactions: { $sum: '$airtimeTransactions' },
        totalDataTransactions: { $sum: '$dataTransactions' },
        totalElectricityTransactions: { $sum: '$electricityTransactions' },
        totalCableTransactions: { $sum: '$cableTransactions' },
        totalFundingTransactions: { $sum: '$fundingTransactions' },
        totalWithdrawalTransactions: { $sum: '$withdrawalTransactions' },
        totalMerchantTransactions: { $sum: '$merchantTransactions' },
        totalMerchantVolume: { $sum: { $toDecimal: '$merchantVolume' } },
        totalNewReferrals: { $sum: '$newReferrals' },
        totalReferralBonusPaid: { $sum: { $toDecimal: '$referralBonusPaid' } },
        totalTicketsOpened: { $sum: '$ticketsOpened' },
        totalTicketsResolved: { $sum: '$ticketsResolved' }
      }
    }
  ]);
};

analyticsSchema.statics.recordDaily = async function(date = new Date()) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  
  const User = mongoose.model('User');
  const Transaction = mongoose.model('Transaction');
  const SupportTicket = mongoose.model('SupportTicket');
  
  const [
    newUsers,
    kycVerified,
    transactions,
    successfulTx,
    failedTx,
    volume,
    revenue,
    airtimeTx,
    dataTx,
    electricityTx,
    cableTx,
    fundingTx,
    withdrawalTx,
    ticketsOpened,
    ticketsResolved
  ] = await Promise.all([
    User.countDocuments({ createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    User.countDocuments({ kycLevel: { $gt: 0 }, kycVerifiedAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ status: 'success', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ status: 'failed', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.aggregate([
      { $match: { createdAt: { $gte: startOfDay, $lt: endOfDay } } },
      { $group: { _id: null, total: { $sum: { $toDecimal: '$amount' } } } }
    ]),
    Transaction.aggregate([
      { $match: { status: 'success', createdAt: { $gte: startOfDay, $lt: endOfDay } } },
      { $group: { _id: null, total: { $sum: { $toDecimal: '$fee' } } } }
    ]),
    Transaction.countDocuments({ type: 'airtime', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ type: 'data', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ type: 'electricity', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ type: 'cable', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ type: 'funding', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    Transaction.countDocuments({ type: 'withdrawal', createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    SupportTicket.countDocuments({ createdAt: { $gte: startOfDay, $lt: endOfDay } }),
    SupportTicket.countDocuments({ status: 'resolved', resolvedAt: { $gte: startOfDay, $lt: endOfDay } })
  ]);
  
  const analytics = await this.findOneAndUpdate(
    { date: startOfDay },
    {
      newUsers,
      kycVerified,
      totalTransactions: transactions,
      successfulTransactions: successfulTx,
      failedTransactions: failedTx,
      totalVolume: volume[0]?.total || 0,
      totalRevenue: revenue[0]?.total || 0,
      airtimeTransactions: airtimeTx,
      dataTransactions: dataTx,
      electricityTransactions: electricityTx,
      cableTransactions: cableTx,
      fundingTransactions: fundingTx,
      withdrawalTransactions: withdrawalTx,
      ticketsOpened,
      ticketsResolved
    },
    { upsert: true, new: true }
  );
  
  return analytics;
};

module.exports = mongoose.model('Analytics', analyticsSchema);
