const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  
  // Level 1: Basic Info
  level1: {
    completed: {
      type: Boolean,
      default: false
    },
    bvn: {
      type: String,
      required: false
    },
    bvnVerified: {
      type: Boolean,
      default: false
    },
    nin: {
      type: String,
      required: false
    },
    ninVerified: {
      type: Boolean,
      default: false
    },
    submittedAt: Date,
    verifiedAt: Date,
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  
  // Level 2: ID Document
  level2: {
    completed: {
      type: Boolean,
      default: false
    },
    idType: {
      type: String,
      enum: ['national_id', 'drivers_license', 'international_passport', 'voters_card'],
      required: false
    },
    idNumber: {
      type: String,
      required: false
    },
    idImage: {
      type: String,
      required: false
    },
    idImageVerified: {
      type: Boolean,
      default: false
    },
    selfieImage: {
      type: String,
      required: false
    },
    selfieVerified: {
      type: Boolean,
      default: false
    },
    submittedAt: Date,
    verifiedAt: Date,
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  
  // Level 3: Address Verification
  level3: {
    completed: {
      type: Boolean,
      default: false
    },
    address: {
      type: String,
      required: false
    },
    city: {
      type: String,
      required: false
    },
    state: {
      type: String,
      required: false
    },
    country: {
      type: String,
      default: 'Nigeria'
    },
    utilityBill: {
      type: String,
      required: false
    },
    utilityBillVerified: {
      type: Boolean,
      default: false
    },
    submittedAt: Date,
    verifiedAt: Date,
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  
  // Overall status
  currentLevel: {
    type: Number,
    default: 0,
    enum: [0, 1, 2, 3]
  },
  
  status: {
    type: String,
    enum: ['pending', 'under_review', 'approved', 'rejected'],
    default: 'pending'
  },
  
  rejectionReason: String,
  
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
kycSchema.index({ user: 1 });
kycSchema.index({ currentLevel: 1 });
kycSchema.index({ status: 1 });

// Instance methods
kycSchema.methods.submitLevel1 = async function(bvn, nin) {
  this.level1.bvn = bvn;
  this.level1.nin = nin;
  this.level1.submittedAt = new Date();
  this.status = 'under_review';
  return this.save();
};

kycSchema.methods.submitLevel2 = async function(idType, idNumber, idImage, selfieImage) {
  this.level2.idType = idType;
  this.level2.idNumber = idNumber;
  this.level2.idImage = idImage;
  this.level2.selfieImage = selfieImage;
  this.level2.submittedAt = new Date();
  this.status = 'under_review';
  return this.save();
};

kycSchema.methods.submitLevel3 = async function(address, city, state, utilityBill) {
  this.level3.address = address;
  this.level3.city = city;
  this.level3.state = state;
  this.level3.utilityBill = utilityBill;
  this.level3.submittedAt = new Date();
  this.status = 'under_review';
  return this.save();
};

kycSchema.methods.approveLevel1 = async function(verifiedBy) {
  this.level1.completed = true;
  this.level1.verifiedAt = new Date();
  this.level1.verifiedBy = verifiedBy;
  this.currentLevel = Math.max(this.currentLevel, 1);
  this.status = 'approved';
  return this.save();
};

kycSchema.methods.approveLevel2 = async function(verifiedBy) {
  this.level2.completed = true;
  this.level2.verifiedAt = new Date();
  this.level2.verifiedBy = verifiedBy;
  this.currentLevel = Math.max(this.currentLevel, 2);
  this.status = 'approved';
  return this.save();
};

kycSchema.methods.approveLevel3 = async function(verifiedBy) {
  this.level3.completed = true;
  this.level3.verifiedAt = new Date();
  this.level3.verifiedBy = verifiedBy;
  this.currentLevel = 3;
  this.status = 'approved';
  return this.save();
};

kycSchema.methods.reject = async function(reason) {
  this.status = 'rejected';
  this.rejectionReason = reason;
  return this.save();
};

kycSchema.methods.resetLevel = async function(level) {
  if (level === 1) {
    this.level1.completed = false;
    this.level1.verifiedAt = null;
    this.level1.verifiedBy = null;
  } else if (level === 2) {
    this.level2.completed = false;
    this.level2.verifiedAt = null;
    this.level2.verifiedBy = null;
  } else if (level === 3) {
    this.level3.completed = false;
    this.level3.verifiedAt = null;
    this.level3.verifiedBy = null;
  }
  this.status = 'pending';
  return this.save();
};

// Static methods
kycSchema.statics.findByUser = function(userId) {
  return this.findOne({ user: userId });
};

kycSchema.statics.findPending = function() {
  return this.find({ status: 'under_review' })
    .populate('user', 'name email phoneNumber')
    .sort({ createdAt: 1 });
};

module.exports = mongoose.model('KYC', kycSchema);
