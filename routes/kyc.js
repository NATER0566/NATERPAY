const mongoose = require('mongoose');
const KYC = require('../models/KYC');
const User = require('../models/User');
const Joi = require('joi'); // [1] Strict Request Validation
const cloudinary = require('cloudinary').v2;
const axios = require('axios'); // ADDED: Required for Paystack API calls

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

// [4] TEXT SANITIZATION (XSS Protection for Addresses & IDs)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 255) : '';

/* =========================================================================
   [5] CLOUDINARY NETWORK RETRY ENGINE
========================================================================= */
async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
}

/* =========================================================================
   [6] REDIS / DISTRIBUTED RATE LIMITING ENGINE
========================================================================= */
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

/* =========================================================================
   GET CURRENT KYC STATUS
========================================================================= */
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
   SUBMIT LEVEL 1: BASIC IDENTITY INFO
========================================================================= */
async function submitLevel1(request, reply) {
    try {
        // [1] Strict Joi Validation (Prevents NoSQL Injection)
        const schema = Joi.object({
            bvn: Joi.string().pattern(/^\d{11}$/).allow('', null),
            nin: Joi.string().pattern(/^\d{11}$/).allow('', null),
            firstName: Joi.string().allow('', null), // ADDED for Paystack Match
            lastName: Joi.string().allow('', null)    // ADDED for Paystack Match
        }).or('bvn', 'nin'); // Requires AT LEAST ONE
        
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        // [6] Extremely strict rate limit to prevent BVN brute-forcing
        if (!await checkRateLimit(request, 'submit_kyc_l1', 3)) throw new Error('Too many verification attempts. Please wait 60 seconds.');

        const { bvn, nin, firstName, lastName } = value;

        // ANTI-DUPLICATION ENGINE
        const orConditions = [];
        if (bvn) orConditions.push({ 'level1.bvn': bvn });
        if (nin) orConditions.push({ 'level1.nin': nin });

        const duplicateCheck = await KYC.findOne({ $or: orConditions, user: { $ne: request.user._id } });
        if (duplicateCheck) {
            throw { status: 403, message: 'SECURITY ALERT: This BVN or NIN is already linked to an existing NATERPAY account.' };
        }

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) kyc = new KYC({ user: request.user._id });

        // Spam Prevention Lock
        if (kyc.currentLevel === 1 && kyc.status === 'under_review') {
            throw new Error('Your Tier 1 submission is already under review. Please wait for an administrator to process it.');
        }

        // =====================================================================
        // NEW PAYSTACK IDENTITY VALIDATION ENGINE (CBN COMPLIANT)
        // =====================================================================
        if (bvn) {
            if (!firstName || !lastName) {
                throw { status: 400, message: 'First Name and Last Name are required to verify your BVN via Paystack.' };
            }

            const user = await User.findById(request.user._id);
            const paystackKey = process.env.PAYSTACK_SECRET_KEY;
            
            if (!paystackKey) throw { status: 500, message: 'System configuration error: Missing verification keys.' };

            const headers = { Authorization: `Bearer ${paystackKey}`, 'Content-Type': 'application/json' };
            let customerCode;

            // Step 1: Create or Fetch Customer on Paystack
            try {
                const createCustomerRes = await axios.post('https://api.paystack.co/customer', {
                    email: user.email,
                    first_name: firstName,
                    last_name: lastName,
                    phone: user.phone || '08000000000'
                }, { headers });
                
                customerCode = createCustomerRes.data.data.customer_code;
            } catch (err) {
                if (err.response && err.response.data && err.response.data.code === 'duplicate_email') {
                    const getCustomerRes = await axios.get(`https://api.paystack.co/customer/${user.email}`, { headers });
                    customerCode = getCustomerRes.data.data.customer_code;
                } else {
                    throw { status: 500, message: 'Failed to initialize secure identity session with Paystack.' };
                }
            }

            // Step 2: Validate the BVN
            try {
                const validateRes = await axios.post(`https://api.paystack.co/customer/${customerCode}/identification`, {
                    country: 'NG',
                    type: 'bvn',
                    value: bvn,
                    first_name: firstName,
                    last_name: lastName
                }, { headers });

                if (validateRes.data.status !== true) {
                    throw new Error('Identity verification failed.');
                }
            } catch (validationError) {
                const paystackMsg = validationError.response?.data?.message || 'Identity verification failed.';
                throw { status: 400, message: `Verification Failed: ${paystackMsg}. Please ensure your First Name and Last Name match your BVN exactly.` };
            }
        }
        // =====================================================================

        kyc.currentLevel = 1; 
        await kyc.submitLevel1(bvn, nin);

        // If BVN was used and successfully verified by Paystack, auto-approve it!
        if (bvn) {
            kyc.status = 'approved';
            if (kyc.level1) kyc.level1.status = 'approved';
            kyc.legalName = `${firstName} ${lastName}`;
            await kyc.save();

            await User.findByIdAndUpdate(request.user._id, { kycLevel: 1, bvn: bvn });

            return reply.send({ success: true, message: 'BVN Verified Successfully! You are now on KYC Level 1.' });
        }

        // If it was a NIN, fallback to manual approval
        reply.send({ success: true, message: 'Details submitted! Awaiting global verification by an Administrator.' });
    } catch (error) { handleError(reply, error, 'Failed to process Tier 1 verification.'); }
}

/* =========================================================================
   SUBMIT LEVEL 2: DOCUMENT UPLOADS (WITH CLOUDINARY INTERCEPTOR)
========================================================================= */
async function submitLevel2(request, reply) {
    try {
        // [1] Validation
        const schema = Joi.object({
            idType: Joi.string().required(),
            idNumber: Joi.string().required(),
            idImage: Joi.string().required(),   // Expected Base64 or URL
            selfieImage: Joi.string().required() // Expected Base64 or URL
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

        // [5] CLOUDINARY SECURE UPLOAD INTERCEPTOR (PREVENTS DATABASE BLOAT)
        // If the frontend sent heavy Base64 strings, we upload them to Cloudinary FIRST
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

        kyc.currentLevel = 2;
        // Notice we pass the SECURE URLs to the model, NEVER the raw Base64 data
        await kyc.submitLevel2(safeIdType, safeIdNumber, secureIdUrl, secureSelfieUrl);

        reply.send({ success: true, message: 'Documents submitted successfully! Please wait for manual admin review.' });
    } catch (error) { handleError(reply, error, 'Failed to process document uploads.'); }
}

/* =========================================================================
   SUBMIT LEVEL 3: ADDRESS PROOF
========================================================================= */
async function submitLevel3(request, reply) {
    try {
        const schema = Joi.object({
            address: Joi.string().required(),
            city: Joi.string().required(),
            state: Joi.string().required()
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

        // [4] Sanitization
        const safeAddress = sanitizeText(value.address);
        const safeCity = sanitizeText(value.city);
        const safeState = sanitizeText(value.state);

        kyc.currentLevel = 3;
        await kyc.submitLevel3(safeAddress, safeCity, safeState, null);

        reply.send({ success: true, message: 'Address submitted! Please wait for final admin approval.' });
    } catch (error) { handleError(reply, error, 'Failed to process address verification.'); }
}

module.exports = { getKYC, submitLevel1, submitLevel2, submitLevel3 };
