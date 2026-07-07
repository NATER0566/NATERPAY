const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const AuditLog = require('../models/AuditLog');

/**
 * Reconcile pending transactions
 */
async function reconcileTransactions() {
  try {
    console.log('Starting transaction reconciliation...');
    
    // Get pending transactions older than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const pendingTransactions = await Transaction.find({
      status: 'pending',
      createdAt: { $lt: fiveMinutesAgo }
    }).limit(100);
    
    let reconciled = 0;
    let failed = 0;
    
    for (const transaction of pendingTransactions) {
      try {
        // Check with provider (simplified - would integrate with actual providers)
        const providerStatus = await checkProviderStatus(transaction);
        
        if (providerStatus === 'success') {
          transaction.status = 'success';
          await transaction.markReconciled('Auto-reconciled as successful');
          reconciled++;
        } else if (providerStatus === 'failed') {
          transaction.status = 'failed';
          await transaction.markReconciled('Auto-reconciled as failed');
          
          // Refund if applicable
          if (['funding', 'withdrawal', 'transfer'].includes(transaction.type)) {
            const wallet = await Wallet.findByUser(transaction.user);
            if (wallet) {
              await wallet.credit(transaction.amount.toString());
            }
          }
          
          failed++;
        }
        
        await transaction.save();
      } catch (error) {
        console.error(`Failed to reconcile transaction ${transaction._id}:`, error);
      }
    }
    
    console.log(`Reconciliation complete: ${reconciled} successful, ${failed} failed`);
    
    return { reconciled, failed };
  } catch (error) {
    console.error('Reconciliation error:', error);
    throw error;
  }
}

/**
 * Check provider status (would integrate with actual providers)
 */
async function checkProviderStatus(transaction) {
  // This is a simplified version - in production, integrate with actual providers
  // For now, we'll simulate status checks
  
  if (!transaction.provider || transaction.provider === 'internal') {
    return 'success';
  }
  
  // Simulate provider API call
  return new Promise((resolve) => {
    setTimeout(() => {
      // 80% success rate for simulation
      resolve(Math.random() > 0.2 ? 'success' : 'failed');
    }, 500);
  });
}

/**
 * Manual reconciliation trigger
 */
async function triggerReconciliation() {
  return reconcileTransactions();
}

module.exports = {
  reconcileTransactions,
  triggerReconciliation
};
