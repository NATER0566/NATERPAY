const mongoose = require('mongoose');

const AdSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    businessName: { type: String, required: true },
    ownerName: { type: String },
    email: { type: String },
    phoneNumber: { type: String },
    whatsappNumber: { type: String },
    address: { type: String },
    
    adType: { type: String, required: true }, // Image, Video, Text, Marketplace, Job, Event, App, Website, PDF
    category: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    targetUrl: { type: String },
    ctaText: { type: String, default: 'Learn More' },
    
    // Dynamic Fields based on Ad Type
    price: { type: Number },          // For Marketplace
    discount: { type: Number },       // For Marketplace
    salary: { type: String },         // For Jobs
    deadline: { type: Date },         // For Jobs
    venue: { type: String },          // For Events
    eventDate: { type: Date },        // For Events
    playStoreUrl: { type: String },   // For Apps
    appStoreUrl: { type: String },    // For Apps

    // Media
    mediaUrl: { type: String, required: true }, // Cloudinary URL
    
    // Targeting
    targetLocation: { type: String, default: 'Global' },
    targetDevice: { type: String, default: 'All' },
    
    // Package & Budgets
    packageType: { type: String, enum: ['basic', 'standard', 'premium', 'enterprise'], required: true },
    packageCost: { type: Number, required: true },
    maxRewardedViews: { type: Number, required: true }, // E.g., 1000 views
    remainingViews: { type: Number, required: true },
    viewBudgetCost: { type: Number, required: true }, // CPRV (Cost Per Rewarded View) total
    rewardAmount: { type: Number, default: 5 }, // Amount user earns per view
    
    // Analytics & Status
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paused', 'expired'], default: 'pending' },
    
    expiryDate: { type: Date, required: true }
}, { timestamps: true });

module.exports = mongoose.model('Ad', AdSchema);
