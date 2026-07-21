const mongoose = require('mongoose');

const cmsSchema = new mongoose.Schema({
  // Homepage data
  homepage: {
    siteName: {
      type: String,
      default: 'NATER-PAY'
    },
    logoUrl: {
      type: String,
      default: null
    },
    tagline: {
      type: String,
      default: 'Enterprise Fintech Services Platform'
    },
    rates: {
      mtn: {
        type: Number,
        default: 215
      },
      airtel: {
        type: Number,
        default: 190
      },
      glo: {
        type: Number,
        default: 220
      },
      nineMobile: {
        type: Number,
        default: 180
      }
    }
  },
  
  // Slides/Media
  slides: [{
    title: {
      type: String,
      required: true
    },
    caption: {
      type: String,
      required: true
    },
    // THE FIX: Added 'text' to the enum array so text-only slides don't fail!
    mediaType: {
      type: String,
      enum: ['image', 'video', 'text'],
      default: 'image'
    },
    // THE FIX: Added the 'type' field that index.html actually reads!
    type: {
      type: String,
      enum: ['image', 'video', 'text'],
      default: 'image'
    },
    mediaUrl: {
      type: String,
      // Removed "required: true" because text-only slides won't have a mediaUrl!
      default: '' 
    },
    ctaText: {
      type: String,
      default: null
    },
    ctaLink: {
      type: String,
      default: null
    },
    order: {
      type: Number,
      default: 0
    },
    isActive: {
      type: Boolean,
      default: true
    }
  }],
  
  // Announcements
  announcements: [{
    title: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: ['info', 'warning', 'success', 'urgent'],
      default: 'info'
    },
    isActive: {
      type: Boolean,
      default: true
    },
    startDate: Date,
    endDate: Date,
    targetAudience: {
      type: String,
      enum: ['all', 'users', 'merchants', 'agents', 'admins'],
      default: 'all'
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Public pages
  about: {
    title: String,
    content: String,
    mission: String,
    vision: String,
    values: [String]
  },
  
  contact: {
    email: String,
    phone: String,
    address: String,
    whatsapp: String,
    socialLinks: {
      facebook: String,
      twitter: String,
      instagram: String,
      linkedin: String
    }
  },
  
  // Footer
  footer: {
    companyName: String,
    tagline: String,
    links: [{
      label: String,
      url: String
    }],
    legalLinks: [{
      label: String,
      url: String
    }]
  },
  
  // SEO
  seo: {
    metaTitle: String,
    metaDescription: String,
    keywords: [String],
    ogImage: String
  },
  
  // Maintenance mode
  maintenanceMode: {
    enabled: {
      type: Boolean,
      default: false
    },
    message: {
      type: String,
      default: 'System under maintenance. Please check back later.'
    },
    scheduledStart: Date,
    scheduledEnd: Date
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

// Static methods
cmsSchema.statics.getHomepageData = function() {
  return this.findOne({}, 'homepage slides announcements maintenanceMode');
};

cmsSchema.statics.getActiveSlides = function() {
  return this.findOne({}, 'slides')
    .then(cms => {
      if (!cms) return [];
      return cms.slides.filter(s => s.isActive).sort((a, b) => a.order - b.order);
    });
};

cmsSchema.statics.getActiveAnnouncements = function(targetAudience = 'all') {
  return this.findOne({}, 'announcements')
    .then(cms => {
      if (!cms) return [];
      const now = new Date();
      return cms.announcements.filter(a => {
        if (!a.isActive) return false;
        if (a.targetAudience !== 'all' && a.targetAudience !== targetAudience) return false;
        if (a.startDate && now < a.startDate) return false;
        if (a.endDate && now > a.endDate) return false;
        return true;
      }).sort((a, b) => b.createdAt - a.createdAt);
    });
};

cmsSchema.statics.updateHomepage = function(data) {
  return this.findOneAndUpdate({}, { $set: { homepage: data } }, { upsert: true, new: true });
};

// --- FIX APPLIED HERE: Bulletproof Slide Addition ---
cmsSchema.statics.addSlide = async function(slideData) {
  try {
    let cms = await this.findOne({});
    if (!cms) {
      cms = new this({ slides: [], announcements: [] });
    }
    cms.slides.push(slideData);
    return await cms.save(); // This enforces strict DB validation
  } catch (error) {
    console.error("CRITICAL DB ERROR SAVING SLIDE:", error);
    throw error;
  }
};

cmsSchema.statics.updateSlide = function(slideId, slideData) {
  return this.findOneAndUpdate(
    { 'slides._id': slideId },
    { $set: { 'slides.$': slideData } },
    { new: true }
  );
};

cmsSchema.statics.deleteSlide = function(slideId) {
  return this.findOneAndUpdate(
    {},
    { $pull: { slides: { _id: slideId } } },
    { new: true }
  );
};

// --- FIX APPLIED HERE: Bulletproof Announcement Addition ---
cmsSchema.statics.addAnnouncement = async function(announcementData) {
  try {
    let cms = await this.findOne({});
    if (!cms) {
      cms = new this({ slides: [], announcements: [] });
    }
    cms.announcements.push(announcementData);
    return await cms.save(); // This enforces strict DB validation
  } catch (error) {
    console.error("CRITICAL DB ERROR SAVING ANNOUNCEMENT:", error);
    throw error;
  }
};

cmsSchema.statics.updateAnnouncement = function(announcementId, announcementData) {
  return this.findOneAndUpdate(
    { 'announcements._id': announcementId },
    { $set: { 'announcements.$': announcementData } },
    { new: true }
  );
};

cmsSchema.statics.deleteAnnouncement = function(announcementId) {
  return this.findOneAndUpdate(
    {},
    { $pull: { announcements: { _id: announcementId } } },
    { new: true }
  );
};

cmsSchema.statics.setMaintenanceMode = function(enabled, message = null, scheduledStart = null, scheduledEnd = null) {
  const update = { 'maintenanceMode.enabled': enabled };
  if (message) update['maintenanceMode.message'] = message;
  if (scheduledStart) update['maintenanceMode.scheduledStart'] = scheduledStart;
  if (scheduledEnd) update['maintenanceMode.scheduledEnd'] = scheduledEnd;
  
  return this.findOneAndUpdate(
    {},
    { $set: update },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('CMS', cmsSchema);
