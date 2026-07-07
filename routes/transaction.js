const Transaction = require('../models/Transaction');

/**
 * Get user transactions
 */
async function getTransactions(request, reply) {
  try {
    const { type, status, limit = 50 } = request.query;
    
    const options = { limit: parseInt(limit) };
    if (type) options.type = type;
    if (status) options.status = status;
    
    const transactions = await Transaction.findByUser(request.user._id, options);
    
    reply.send({
      success: true,
      transactions: transactions.map(tx => ({
        _id: tx._id,
        date: tx.createdAt,
        type: tx.type,
        subtype: tx.subtype,
        description: tx.description,
        amount: tx.amount.toString(),
        fee: tx.fee.toString(),
        balanceBefore: tx.balanceBefore.toString(),
        balanceAfter: tx.balanceAfter.toString(),
        status: tx.status,
        provider: tx.provider,
        providerReference: tx.providerReference,
        serviceDetails: tx.serviceDetails
      }))
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
 * Get single transaction
 */
async function getTransaction(request, reply) {
  try {
    const { id } = request.params;
    
    const transaction = await Transaction.findOne({
      _id: id,
      user: request.user._id
    });
    
    if (!transaction) {
      return reply.status(404).send({
        success: false,
        message: 'Transaction not found'
      });
    }
    
    reply.send({
      success: true,
      transaction
    });
  } catch (error) {
    console.error('Get transaction error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch transaction'
    });
  }
}

module.exports = {
  getTransactions,
  getTransaction
};
