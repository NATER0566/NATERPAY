const mongoose = require('mongoose');
const KYC = require('../models/KYC');
const User = require('../models/User');
const Joi = require('joi'); 
const cloudinary = require('cloudinary').v2;
const axios = require('axios'); 

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
   SUBMIT LEVEL 1: EXACT PAYSTACK BANK ACCOUNT MATCHING ENGINE
========================================================================= */
async function submitLevel1(request, reply) {
    try {
        const schema = Joi.object({
            bvn: Joi.string().pattern(/^\d{11}$/).allow('', null),
            nin: Joi.string().pattern(/^\d{11}$/).allow('', null),
            firstName: Joi.string().allow('', null), 
            lastName: Joi.string().allow('', null),
            accountNumber: Joi.string().pattern(/^\d{10}$/).allow('', null), // REQUIRED FOR PAYSTACK
            bankCode: Joi.string().allow('', null) // REQUIRED FOR PAYSTACK
        }).or('bvn', 'nin'); 
        
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        if (!await checkRateLimit(request, 'submit_kyc_l1', 3)) throw new Error('Too many verification attempts. Please wait 60 seconds.');

        const { bvn, nin, firstName, lastName, accountNumber, bankCode } = value;

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

        if (bvn) {
            if (!firstName || !lastName || !accountNumber || !bankCode) {
                throw { status: 400, message: 'First Name, Last Name, Account Number, and Bank are strictly required by Paystack for BVN verification.' };
            }

            const user = await User.findById(request.user._id);
            const paystackKey = process.env.PAYSTACK_SECRET_KEY;
            
            if (!paystackKey) throw { status: 500, message: 'System error: Missing verification keys.' };

            const headers = { Authorization: `Bearer ${paystackKey}`, 'Content-Type': 'application/json' };
            let customerCode;

            // Step 1: Initialize Customer
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
                    throw { status: 500, message: 'Failed to communicate with Paystack.' };
                }
            }

            // Step 2: Exact Paystack Bank Account Payload
            if (customerCode) {
                try {
                    const validateRes = await axios.post(`https://api.paystack.co/customer/${customerCode}/identification`, {
                        country: 'NG',
                        type: 'bank_account', // STRICT REQUIREMENT FROM DOCS
                        account_number: accountNumber,
                        bvn: bvn,
                        bank_code: bankCode,
                        first_name: firstName,
                        last_name: lastName
                    }, { headers });

                    if (validateRes.data.status !== true) {
                        throw new Error('Identity verification submission failed.');
                    }
                } catch (validationError) {
                    const paystackMsg = validationError.response?.data?.message || validationError.message || 'Verification failed.';
                    throw { status: 400, message: `Paystack Validation Failed: ${paystackMsg}` };
                }
            }
        }

        kyc.currentLevel = 1; 
        await kyc.submitLevel1(bvn, nin);

        // Since Paystack validation happens asynchronously, we place them in under_review immediately
        kyc.status = 'under_review';
        if (kyc.level1) kyc.level1.status = 'under_review';
        if (firstName && lastName) kyc.legalName = `${firstName} ${lastName}`;
        await kyc.save();

        await User.findByIdAndUpdate(request.user._id, { bvn: bvn });

        return reply.send({ success: true, message: 'Details submitted securely to Paystack! Your identity is currently being processed. You can proceed to the next step.' });

    } catch (error) { handleError(reply, error, 'Failed to process Tier 1 verification.'); }
}

/* =========================================================================
   SUBMIT LEVEL 2: DOCUMENT UPLOADS
========================================================================= */
async function submitLevel2(request, reply) {
    try {
        const schema = Joi.object({
            idType: Joi.string().required(),
            idNumber: Joi.string().required(),
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

        kyc.currentLevel = 2;
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

        const safeAddress = sanitizeText(value.address);
        const safeCity = sanitizeText(value.city);
        const safeState = sanitizeText(value.state);

        kyc.currentLevel = 3;
        await kyc.submitLevel3(safeAddress, safeCity, safeState, null);

        reply.send({ success: true, message: 'Address submitted! Please wait for final admin approval.' });
    } catch (error) { handleError(reply, error, 'Failed to process address verification.'); }
}

module.exports = { getKYC, submitLevel1, submitLevel2, submitLevel3 };
