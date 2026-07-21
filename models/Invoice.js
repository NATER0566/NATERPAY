const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
    description: { 
        type: String, 
        required: true 
    },
    quantity: { 
        type: Number, 
        required: true, 
        min: 1, 
        default: 1 
    },
    unitPrice: { 
        type: mongoose.Schema.Types.Decimal128, 
        required: true 
    },
    total: { 
        type: mongoose.Schema.Types.Decimal128, 
        required: true 
    }
});

const invoiceSchema = new mongoose.Schema({
    user: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true, 
        index: true 
    },
    invoiceId: { 
        type: String, 
        required: true, 
        unique: true, 
        index: true 
    },
    businessLogoBase64: { 
        type: String, 
        default: null 
    },
    businessDetails: { 
        type: Object, 
        default: {} 
    },
    customerName: { 
        type: String, 
        required: true 
    },
    customerEmail: { 
        type: String, 
        required: true 
    },
    customerPhone: { 
        type: String, 
        default: null 
    },
    items: [invoiceItemSchema],
    subtotal: { 
        type: mongoose.Schema.Types.Decimal128, 
        required: true 
    },
    tax: { 
        type: mongoose.Schema.Types.Decimal128, 
        default: 0 
    },
    taxRate: { 
        type: Number, 
        default: 0 
    },
    discount: { 
        type: mongoose.Schema.Types.Decimal128, 
        default: 0 
    },
    discountRate: { 
        type: Number, 
        default: 0 
    },
    total: { 
        type: mongoose.Schema.Types.Decimal128, 
        required: true 
    },
    currency: { 
        type: String, 
        default: 'NGN' 
    },
    dueDate: { 
        type: Date, 
        required: true 
    },
    notes: { 
        type: String, 
        default: null 
    },
    terms: { 
        type: String, 
        default: null 
    },
    status: { 
        type: String, 
        enum: ['draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'], 
        default: 'draft' 
    },
    paidAt: Date,
    paymentReference: String,
    paymentMethod: String,
    
    // Reminder settings
    remindersEnabled: { 
        type: Boolean, 
        default: true 
    },
    reminderSent: { 
        type: Boolean, 
        default: false 
    },
    reminderSentAt: Date,
    
    // Metadata
    metadata: { 
        type: Map, 
        of: mongoose.Schema.Types.Mixed, 
        default: new Map() 
    }
}, { 
    timestamps: true 
});

// Indexes for fast querying
invoiceSchema.index({ user: 1, status: 1 });
invoiceSchema.index({ dueDate: 1 });

// Pre-save middleware to auto-generate an ID if one isn't provided
invoiceSchema.pre('save', function(next) {
    if (!this.invoiceId) {
        this.invoiceId = 'inv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    }
    next();
});

// Instance methods used by routes/invoice.js
invoiceSchema.methods.markAsSent = function() {
    this.status = 'sent';
    return this.save();
};

invoiceSchema.methods.markAsViewed = function() {
    this.status = 'viewed';
    return this.save();
};

invoiceSchema.methods.markAsPaid = function(paymentReference, paymentMethod) {
    this.status = 'paid';
    this.paidAt = new Date();
    this.paymentReference = paymentReference;
    this.paymentMethod = paymentMethod;
    return this.save();
};

invoiceSchema.methods.markAsOverdue = function() {
    this.status = 'overdue';
    return this.save();
};

invoiceSchema.methods.cancel = function() {
    this.status = 'cancelled';
    return this.save();
};

invoiceSchema.methods.sendReminder = function() {
    this.reminderSent = true;
    this.reminderSentAt = new Date();
    return this.save();
};

invoiceSchema.methods.isOverdue = function() {
    return this.dueDate < new Date() && !['paid', 'cancelled'].includes(this.status);
};

// Static methods used by routes/invoice.js
invoiceSchema.statics.findByUser = function(userId) {
    return this.find({ user: userId }).sort({ createdAt: -1 });
};

invoiceSchema.statics.findByInvoiceId = function(invoiceId) {
    return this.findOne({ invoiceId });
};

invoiceSchema.statics.findOverdue = function() {
    return this.find({
        status: { $in: ['sent', 'viewed'] },
        dueDate: { $lt: new Date() }
    });
};

invoiceSchema.statics.findPending = function(userId) {
    return this.find({
        user: userId,
        status: { $in: ['sent', 'viewed'] }
    }).sort({ dueDate: 1 });
};

// Ensures data is sent to the frontend accurately without crashing the UI with raw MongoDB Decimal objects
invoiceSchema.set('toJSON', {
    transform: function(doc, ret) {
        if (ret.subtotal) ret.subtotal = parseFloat(ret.subtotal.toString()).toFixed(2);
        if (ret.tax) ret.tax = parseFloat(ret.tax.toString()).toFixed(2);
        if (ret.discount) ret.discount = parseFloat(ret.discount.toString()).toFixed(2);
        if (ret.total) ret.total = parseFloat(ret.total.toString()).toFixed(2);
        
        if (ret.items && Array.isArray(ret.items)) {
            ret.items = ret.items.map(item => ({
                ...item,
                unitPrice: item.unitPrice ? parseFloat(item.unitPrice.toString()).toFixed(2) : '0.00',
                total: item.total ? parseFloat(item.total.toString()).toFixed(2) : '0.00'
            }));
        }
        return ret;
    }
});

module.exports = mongoose.model('Invoice', invoiceSchema);
