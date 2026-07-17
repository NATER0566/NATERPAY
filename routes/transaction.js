const Transaction = require('../models/Transaction');

// Helper Engine to determine cash flow direction securely
function determineCashFlow(type, description) {
    const txType = String(type || '').toLowerCase();
    const desc = String(description || '').toLowerCase();

    // Specific actions that mean money physically entered the user's wallet
    if (['funding', 'invoice', 'payment_link', 'salary', 'bonus', 'refund', 'referral_bonus'].includes(txType)) {
        return 'in';
    } 
    // Catch Admin Credits explicitly based on description
    else if (desc.includes('admin credit')) {
        return 'in';
    }
    // If it's a P2P transfer, we check the description string saved in the ledger
    else if (txType === 'transfer') {
        if (desc.includes('received') || desc.includes('from')) {
            return 'in';
        }
    }
    
    // Default to money going out (withdrawals, airtime, data, transfers sent)
    return 'out';
}

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
        // Safe string conversions to prevent database crash loops
        amount: tx.amount ? tx.amount.toString() : '0',
        fee: tx.fee ? tx.fee.toString() : '0',
        totalDeduction: tx.totalDeduction ? tx.totalDeduction.toString() : '0', // FIX: Added totalDeduction extraction
        balanceBefore: tx.balanceBefore ? tx.balanceBefore.toString() : '0',
        balanceAfter: tx.balanceAfter ? tx.balanceAfter.toString() : '0',
        status: tx.status,
        provider: tx.provider,
        providerReference: tx.providerReference,
        serviceDetails: tx.serviceDetails,
        // THIS IS THE FIX: The backend now commands the frontend cash flow
        flow: determineCashFlow(tx.type, tx.description) 
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
    
    // Convert mongoose document to plain object to attach custom flow rules
    const txObj = transaction.toObject ? transaction.toObject() : transaction;
    
    txObj.flow = determineCashFlow(txObj.type, txObj.description);
    if(txObj.amount) txObj.amount = txObj.amount.toString();
    if(txObj.fee) txObj.fee = txObj.fee.toString();
    if(txObj.totalDeduction) txObj.totalDeduction = txObj.totalDeduction.toString(); // FIX: Added single transaction totalDeduction
    if(txObj.balanceBefore) txObj.balanceBefore = txObj.balanceBefore.toString();
    if(txObj.balanceAfter) txObj.balanceAfter = txObj.balanceAfter.toString();

    reply.send({
      success: true,
      transaction: txObj
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
