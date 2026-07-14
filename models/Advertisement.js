const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    businessName: { type: String, required: true },
    title: { type: String, required: true },
    description: String,
    category: String,
    imageUrl: String,
    videoUrl: String,
    phoneNumber: String,
    whatsappNumber: String,
    website: String,
    location: String,
    package: { type: String, enum: ['basic', 'standard', 'premium'] },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired'], default: 'pending' },
    featured: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    startDate: Date,
    endDate: Date
}, { timestamps: true });

module.exports = mongoose.model('Advertisement', adSchema);
