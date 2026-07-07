const KYC = require('../models/KYC');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');

/**
 * Get KYC status
 */
async function getKYC(request, reply) {
  try {
    const kyc = await KYC.findByUser(request.user._id);
    
    if (!kyc) {
      return reply.send({
        success: true,
        currentLevel: 0,
        status: 'pending',
        levels: {
          level1: { completed: false },
          level2: { completed: false },
          level3: { completed: false }
        }
      });
    }
    
    reply.send({
      success: true,
      currentLevel: kyc.currentLevel,
      status: kyc.status,
      rejectionReason: kyc.rejectionReason,
      levels: {
        level1: {
          completed: kyc.level1.completed,
          submittedAt: kyc.level1.submittedAt,
          verifiedAt: kyc.level1.verifiedAt
        },
        level2: {
          completed: kyc.level2.completed,
          submittedAt: kyc.level2.submittedAt,
          verifiedAt: kyc.level2.verifiedAt
        },
        level3: {
          completed: kyc.level3.completed,
          submittedAt: kyc.level3.submittedAt,
          verifiedAt: kyc.level3.verifiedAt
        }
      }
    });
  } catch (error) {
    console.error('Get KYC error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch KYC status'
    });
  }
}

/**
 * Submit Level 1 KYC (BVN/NIN)
 */
async function submitLevel1(request, reply) {
  try {
    const { bvn, nin } = request.body;
    
    if (!bvn && !nin) {
      return reply.status(400).send({
        success: false,
        message: 'BVN or NIN is required'
      });
    }
    
    let kyc = await KYC.findByUser(request.user._id);
    if (!kyc) {
      kyc = new KYC({ user: request.user._id });
    }
    
    await kyc.submitLevel1(bvn, nin);
    
    // Update user KYC data
    if (bvn) request.user.kycData.bvn = bvn;
    if (nin) request.user.kycData.nin = nin;
    await request.user.save();
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'kyc_submit',
      description: 'Level 1 KYC submitted',
      details: { bvn: bvn ? '***' : null, nin: nin ? '***' : null },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await Notification.create({
      user: request.user._id,
      title: 'KYC Level 1 Submitted',
      message: 'Your Level 1 KYC has been submitted for review',
      type: 'kyc',
      priority: 'medium'
    });
    
    reply.send({
      success: true,
      message: 'Level 1 KYC submitted successfully'
    });
  } catch (error) {
    console.error('Submit Level 1 error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to submit Level 1 KYC'
    });
  }
}

/**
 * Submit Level 2 KYC (ID Document)
 */
async function submitLevel2(request, reply) {
  try {
    const { idType, idNumber, idImage, selfieImage } = request.body;
    
    if (!idType || !idNumber || !idImage) {
      return reply.status(400).send({
        success: false,
        message: 'ID type, number, and image are required'
      });
    }
    
    let kyc = await KYC.findByUser(request.user._id);
    if (!kyc) {
      kyc = new KYC({ user: request.user._id });
    }
    
    await kyc.submitLevel2(idType, idNumber, idImage, selfieImage);
    
    // Update user KYC data
    request.user.kycData.idType = idType;
    request.user.kycData.idNumber = idNumber;
    request.user.kycData.idImage = idImage;
    if (selfieImage) request.user.kycData.selfieImage = selfieImage;
    await request.user.save();
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'kyc_submit',
      description: 'Level 2 KYC submitted',
      details: { idType, idNumber: '***' },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await Notification.create({
      user: request.user._id,
      title: 'KYC Level 2 Submitted',
      message: 'Your Level 2 KYC has been submitted for review',
      type: 'kyc',
      priority: 'medium'
    });
    
    reply.send({
      success: true,
      message: 'Level 2 KYC submitted successfully'
    });
  } catch (error) {
    console.error('Submit Level 2 error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to submit Level 2 KYC'
    });
  }
}

/**
 * Submit Level 3 KYC (Address Verification)
 */
async function submitLevel3(request, reply) {
  try {
    const { address, city, state, utilityBill } = request.body;
    
    if (!address || !city || !state) {
      return reply.status(400).send({
        success: false,
        message: 'Address, city, and state are required'
      });
    }
    
    let kyc = await KYC.findByUser(request.user._id);
    if (!kyc) {
      kyc = new KYC({ user: request.user._id });
    }
    
    await kyc.submitLevel3(address, city, state, utilityBill);
    
    // Update user KYC data
    request.user.kycData.address = address;
    request.user.kycData.city = city;
    request.user.kycData.state = state;
    if (utilityBill) request.user.kycData.utilityBill = utilityBill;
    await request.user.save();
    
    await AuditLog.logAction({
      user: request.user._id,
      action: 'kyc_submit',
      description: 'Level 3 KYC submitted',
      details: { address, city, state },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    await Notification.create({
      user: request.user._id,
      title: 'KYC Level 3 Submitted',
      message: 'Your Level 3 KYC has been submitted for review',
      type: 'kyc',
      priority: 'medium'
    });
    
    reply.send({
      success: true,
      message: 'Level 3 KYC submitted successfully'
    });
  } catch (error) {
    console.error('Submit Level 3 error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to submit Level 3 KYC'
    });
  }
}

module.exports = {
  getKYC,
  submitLevel1,
  submitLevel2,
  submitLevel3
};
