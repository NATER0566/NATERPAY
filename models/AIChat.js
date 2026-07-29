const mongoose = require('mongoose');

const aiChatSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    role: {
        type: String,
        enum: ['user', 'model'], // 'user' is the customer, 'model' is NATERPAY AI
        required: true
    },
    message: {
        type: String,
        required: true
    },
    // We can store the function calls here if we want to debug what the AI did
    actionTaken: {
        type: String,
        default: null
    }
}, { 
    timestamps: true 
});

module.exports = mongoose.model('AIChat', aiChatSchema);
