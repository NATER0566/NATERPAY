const mongoose = require('mongoose');
const KYC = require('../models/KYC');
const User = require('../models/User');
const Joi = require('joi'); 
const cloudinary = require('cloudinary').v2;

// [2] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let Redis;
try { Redis = require('ioredis'); } catch(e) {}

// [3] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [4] TEXT SANITIZATION
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 255) : '';

async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
}

const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 5) {
    const ip = request.ip;
    const userId = request.user ? request.user._id : 'anon';
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const userKey = `rate_${action}_user_${userId}`;
        if (!fallbackRateLimits.has(userKey)) {
            fallbackRateLimits.set(userKey, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(userKey);
        if (now > data.resetTime) {
            fallbackRateLimits.set(userKey, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const userKey = `rate:${action}:user:${userId}`;
            const count = await redisClient.incr(userKey);
            if (count === 1) await redisClient.expire(userKey, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

async function getKYC(request, reply) {
    try {
        if (!await checkRateLimit(request, 'get_kyc', 30)) throw { status: 429, message: 'Too many requests.' };

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) {
            kyc = new KYC({ user: request.user._id, currentLevel: 0, status: 'pending' });
            await kyc.save();
        }
        reply.send({ success: true, kyc: { currentLevel: kyc.currentLevel, status: kyc.status } });
    } catch (error) { handleError(reply, error, 'Failed to retrieve KYC data.'); }
}

/* =========================================================================
   SUBMIT LEVEL 1: MANUAL BACKEND LOGIC (PAYSTACK COMPLETELY REMOVED)
========================================================================= */
async function submitLevel1(request, reply) {
    try {
        const schema = Joi.object({
            bvn: Joi.string().pattern(/^\d{11}$/).allow('', null),
            nin: Joi.string().pattern(/^\d{11}$/).allow('', null),
            firstName: Joi.string().allow('', null), 
            lastName: Joi.string().allow('', null)
        }).or('bvn', 'nin'); 
        
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'submit_kyc_l1', 3)) throw new Error('Too many verification attempts. Please wait 60 seconds.');

        const { bvn, nin, firstName, lastName } = value;

        const orConditions = [];
        if (bvn) orConditions.push({ 'level1.bvn': bvn });
        if (nin) orConditions.push({ 'level1.nin': nin });

        const duplicateCheck = await KYC.findOne({ $or: orConditions, user: { $ne: request.user._id } });
        if (duplicateCheck) {
            throw { status: 403, message: 'SECURITY ALERT: This BVN or NIN is already linked to an existing account.' };
        }

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) kyc = new KYC({ user: request.user._id });

        if (kyc.currentLevel === 1 && kyc.status === 'under_review') {
            throw new Error('Your Tier 1 submission is already under review.');
        }

        kyc.currentLevel = 1; 
        await kyc.submitLevel1(bvn, nin);

        // Instantly mark as under review for Admin processing
        kyc.status = 'under_review';
        if (kyc.level1) kyc.level1.status = 'under_review';
        if (firstName && lastName) kyc.legalName = `${firstName} ${lastName}`;
        await kyc.save();

        await User.findByIdAndUpdate(request.user._id, { bvn: bvn });

        return reply.send({ success: true, message: 'Your record has been securely captured.' });

    } catch (error) { handleError(reply, error, 'Failed to process Tier 1 verification.'); }
}

/* =========================================================================
   SUBMIT LEVEL 2: DOCUMENT UPLOADS (UPDATED WITH DOB & EXPIRY)
========================================================================= */
async function submitLevel2(request, reply) {
    try {
        const schema = Joi.object({
            idType: Joi.string().required(),
            idNumber: Joi.string().required(),
            dob: Joi.string().required(),         
            expiryDate: Joi.string().allow('', null), 
            idImage: Joi.string().required(),   
            selfieImage: Joi.string().required() 
        });
        
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'submit_kyc_l2', 3)) throw new Error('Too many verification attempts.');

        const user = await User.findById(request.user._id);
        let kyc = await KYC.findOne({ user: request.user._id });
        
        if (!kyc || user.kycLevel < 1) {
            throw new Error('Your TIER 1 Identity must be APPROVED by an Admin before submitting TIER 2.');
        }

        if (kyc.currentLevel === 2 && kyc.status === 'under_review') {
            throw new Error('Your Tier 2 documents are already under review.');
        }

        let secureIdUrl = value.idImage;
        let secureSelfieUrl = value.selfieImage;

        if (secureIdUrl.startsWith('data:image')) {
            const idUpload = await withRetry(() => cloudinary.uploader.upload(secureIdUrl, { folder: 'naterpay_kyc', resource_type: 'auto', timeout: 15000 }));
            secureIdUrl = idUpload.secure_url;
        }

        if (secureSelfieUrl.startsWith('data:image')) {
            const selfieUpload = await withRetry(() => cloudinary.uploader.upload(secureSelfieUrl, { folder: 'naterpay_kyc', resource_type: 'auto', timeout: 15000 }));
            secureSelfieUrl = selfieUpload.secure_url;
        }

        const safeIdType = sanitizeText(value.idType);
        const safeIdNumber = sanitizeText(value.idNumber);
        
        // Save new date fields securely
        kyc.level2 = kyc.level2 || {};
        kyc.level2.dob = sanitizeText(value.dob);
        kyc.level2.expiryDate = sanitizeText(value.expiryDate);

        kyc.currentLevel = 2;
        await kyc.submitLevel2(safeIdType, safeIdNumber, secureIdUrl, secureSelfieUrl);

        reply.send({ success: true, message: 'Your record has been securely captured.' });
    } catch (error) { handleError(reply, error, 'Failed to process document uploads.'); }
}

/* =========================================================================
   SUBMIT LEVEL 3: ADDRESS PROOF (UPDATED WITH DOCUMENT UPLOAD)
========================================================================= */
async function submitLevel3(request, reply) {
    try {
        const schema = Joi.object({
            address: Joi.string().required(),
            city: Joi.string().required(),
            state: Joi.string().required(),
            addressImage: Joi.string().required() 
        });
        
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'submit_kyc_l3', 3)) throw new Error('Too many verification attempts.');

        const user = await User.findById(request.user._id);
        let kyc = await KYC.findOne({ user: request.user._id });
        
        if (!kyc || user.kycLevel < 2) {
            throw new Error('Your TIER 2 Documents must be APPROVED before submitting Address Verification.');
        }

        if (kyc.currentLevel === 3 && kyc.status === 'under_review') {
            throw new Error('Your Tier 3 address is already under review.');
        }

        let secureAddressUrl = value.addressImage;

        // Supports both image files and PDF documents for utility bills
        if (secureAddressUrl.startsWith('data:image') || secureAddressUrl.startsWith('data:application/pdf')) {
            const addressUpload = await withRetry(() => cloudinary.uploader.upload(secureAddressUrl, { folder: 'naterpay_kyc', resource_type: 'auto', timeout: 15000 }));
            secureAddressUrl = addressUpload.secure_url;
        }

        const safeAddress = sanitizeText(value.address);
        const safeCity = sanitizeText(value.city);
        const safeState = sanitizeText(value.state);

        kyc.currentLevel = 3;
        await kyc.submitLevel3(safeAddress, safeCity, safeState, secureAddressUrl);

        reply.send({ success: true, message: 'Your record has been securely captured.' });
    } catch (error) { handleError(reply, error, 'Failed to process address verification.'); }
}

module.exports = { getKYC, submitLevel1, submitLevel2, submitLevel3 };
