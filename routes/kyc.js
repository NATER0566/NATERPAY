const mongoose = require('mongoose');
const KYC = require('../models/KYC');
const User = require('../models/User');
const Joi = require('joi'); 
const cloudinary = require('cloudinary').v2;
const flutterwave = require('../services/flutterwave');
const ninProvider = require('../services/nin');
const { encrypt } = require('../utils/secure-kyc');
const walletRoutes = require('./wallet');

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
        const user = await User.findById(request.user._id).select('email phoneNumber name kycVerified bvnVerified ninVerified kycData.bvnLast4 kycData.ninLast4');
        reply.send({
            success: true,
            kyc: {
                currentLevel: kyc.currentLevel,
                status: kyc.status,
                kycVerified: user?.kycVerified === true,
                bvnVerified: user?.bvnVerified === true,
                ninVerified: user?.ninVerified === true,
                bvnLast4: user?.kycData?.bvnLast4 || null,
                ninLast4: user?.kycData?.ninLast4 || null,
                ninCollected: Boolean(kyc.level1?.ninEncrypted)
            },
            user: user ? {
                name: user.name,
                email: user.email,
                phoneNumber: user.phoneNumber
            } : null
        });
    } catch (error) { handleError(reply, error, 'Failed to retrieve KYC data.'); }
}

function normalizedName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).sort().join(' ');
}

function nameDistance(first, second) {
    const a = normalizedName(first);
    const b = normalizedName(second);
    if (!a || !b) return Infinity;
    const matrix = Array.from({ length: a.length + 1 }, (_, row) => [row]);
    for (let column = 0; column <= b.length; column++) matrix[0][column] = column;
    for (let row = 1; row <= a.length; row++) {
        for (let column = 1; column <= b.length; column++) {
            matrix[row][column] = a[row - 1] === b[column - 1]
                ? matrix[row - 1][column - 1]
                : Math.min(matrix[row - 1][column] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column - 1] + 1);
        }
    }
    return matrix[a.length][b.length];
}

function bvnMatchesName(fullName, bvnData) {
    const returnedName = bvnData?.full_name ||
        [bvnData?.first_name, bvnData?.middle_name, bvnData?.last_name].filter(Boolean).join(' ');
    if (!returnedName) return false;
    const first = normalizedName(fullName);
    const second = normalizedName(returnedName);
    return first === second || nameDistance(first, second) <= 2;
}

function providerName(data) {
    return data?.full_name || data?.fullName ||
        [data?.first_name || data?.firstname, data?.middle_name || data?.middlename, data?.last_name || data?.lastname]
            .filter(Boolean).join(' ');
}

function providerDob(data) {
    return data?.date_of_birth || data?.dateOfBirth || data?.dob || null;
}

function providerPhone(data) {
    return data?.phone_number || data?.phoneNumber || data?.mobile || data?.phone || null;
}

function sameDate(first, second) {
    if (!first || !second) return false;
    const normalize = value => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
    };
    return normalize(first) === normalize(second);
}

async function verifyKYC(request, reply) {
    try {
        const schema = Joi.object({
            bvn: Joi.string().pattern(/^\d{11}$/).required(),
            nin: Joi.string().pattern(/^\d{11}$/).required(),
            dob: Joi.date().iso().required(),
            fullName: Joi.string().min(2).max(120).required()
        });
        const { error, value } = schema.validate(request.body || {});
        if (error) return reply.code(400).send({ success: false, message: error.details[0].message });
        if (!await checkRateLimit(request, 'verify_kyc', 3)) {
            return reply.code(429).send({ success: false, message: 'Too many verification attempts. Please wait 60 seconds.' });
        }

        const user = await User.findById(request.user._id);
        if (!user) return reply.code(404).send({ success: false, message: 'User account not found.' });
        if (user.kycVerified && user.bvnVerified && user.ninVerified) {
            try {
                await walletRoutes.createDedicatedAccountForUser(user._id);
                return reply.send({ success: true, message: 'KYC Verified - BVN and NIN Verified - Your dedicated account has been created' });
            } catch (accountError) {
                return reply.code(502).send({ success: false, kycVerified: true, message: accountError.message || 'Your dedicated account could not be created yet.' });
            }
        }

        let bvnData;
        try {
            bvnData = await flutterwave.verifyBVN(value.bvn);
        } catch (_) {
            const failedKyc = await KYC.findOne({ user: user._id }) || new KYC({ user: user._id });
            failedKyc.status = 'rejected';
            failedKyc.rejectionReason = 'BVN verification failed';
            await failedKyc.save();
            user.kycVerified = false;
            user.bvnVerified = false;
            user.ninVerified = false;
            user.kycStatus = 'rejected';
            await user.save();
            return reply.code(400).send({
                success: false,
                message: 'BVN verification failed'
            });
        }
        const returnedBvnName = providerName(bvnData);
        const returnedBvnDob = providerDob(bvnData);
        const returnedBvnPhone = providerPhone(bvnData);
        if (!bvnMatchesName(value.fullName, bvnData)) {
            const failedKyc = await KYC.findOne({ user: user._id }) || new KYC({ user: user._id });
            failedKyc.status = 'rejected';
            failedKyc.rejectionReason = 'BVN name does not match your name';
            await failedKyc.save();
            user.kycVerified = false;
            user.bvnVerified = false;
            user.ninVerified = false;
            user.kycStatus = 'rejected';
            await user.save();
            return reply.code(400).send({
                success: false,
                message: 'BVN name does not match your name'
            });
        }
        if (returnedBvnDob && !sameDate(value.dob, returnedBvnDob)) {
            const failedKyc = await KYC.findOne({ user: user._id }) || new KYC({ user: user._id });
            failedKyc.status = 'rejected';
            failedKyc.rejectionReason = 'BVN verification failed';
            await failedKyc.save();
            user.kycVerified = false;
            user.bvnVerified = false;
            user.ninVerified = false;
            user.kycStatus = 'rejected';
            await user.save();
            return reply.code(400).send({ success: false, message: 'BVN verification failed' });
        }

        const kyc = await KYC.findOne({ user: user._id }) || new KYC({ user: user._id });
        kyc.level1 = kyc.level1 || {};
        kyc.level1.completed = true;
        kyc.level1.bvnEncrypted = encrypt(value.bvn);
        kyc.level1.bvnLast4 = value.bvn.slice(-4);
        kyc.level1.bvnName = returnedBvnName;
        kyc.level1.bvnPhoneNumber = returnedBvnPhone;
        kyc.level1.bvnDateOfBirth = returnedBvnDob;
        kyc.level1.ninEncrypted = encrypt(value.nin);
        kyc.level1.ninLast4 = value.nin.slice(-4);
        kyc.level1.bvnVerified = true;
        kyc.level1.bvnVerifiedAt = new Date();
        kyc.level1.submittedAt = new Date();
        kyc.level1.legalName = value.fullName;
        kyc.currentLevel = Math.max(kyc.currentLevel || 0, 1);

        user.kycData = user.kycData || {};
        user.kycData.bvnEncrypted = encrypt(value.bvn);
        user.kycData.bvnLast4 = value.bvn.slice(-4);
        user.kycData.bvnName = returnedBvnName;
        user.kycData.bvnPhoneNumber = returnedBvnPhone;
        user.kycData.bvnDateOfBirth = returnedBvnDob;
        user.kycData.ninEncrypted = encrypt(value.nin);
        user.kycData.ninLast4 = value.nin.slice(-4);
        user.kycData.dateOfBirth = value.dob;
        user.bvnVerified = true;
        user.kycSubmittedAt = new Date();

        let ninData;
        try {
            ninData = await ninProvider.verifyNIN(value.nin);
        } catch (ninError) {
            const awaiting = ninError.statusCode === 503;
            kyc.level1.ninVerified = false;
            kyc.status = awaiting ? 'bvn_verified_awaiting_nin' : 'bvn_verified_nin_failed';
            user.ninVerified = false;
            user.kycVerified = false;
            user.kycStatus = awaiting ? 'bvn_verified_awaiting_nin' : 'bvn_verified_nin_failed';
            await Promise.all([kyc.save(), user.save()]);
            return reply.code(ninError.statusCode || 400).send({
                success: false,
                message: ninError.message
            });
        }

        const returnedNinName = providerName(ninData);
        const returnedNinDob = providerDob(ninData);
        if (!bvnMatchesName(value.fullName, ninData) ||
            !bvnMatchesName(returnedBvnName, ninData) ||
            !sameDate(value.dob, returnedNinDob) ||
            (returnedBvnDob && !sameDate(returnedBvnDob, returnedNinDob))) {
            kyc.level1.ninVerified = false;
            kyc.status = 'bvn_verified_nin_failed';
            user.ninVerified = false;
            user.kycVerified = false;
            user.kycStatus = 'bvn_verified_nin_failed';
            await Promise.all([kyc.save(), user.save()]);
            return reply.code(400).send({
                success: false,
                message: 'BVN and NIN details do not match - same person must own both'
            });
        }

        const verifiedAt = new Date();
        kyc.level1.ninVerified = true;
        kyc.level1.ninVerifiedAt = verifiedAt;
        kyc.level1.verifiedAt = verifiedAt;
        kyc.status = 'verified';
        user.ninVerified = true;
        user.kycVerified = true;
        user.kycLevel = Math.max(user.kycLevel || 0, 1);
        user.kycStatus = 'verified';
        user.bvnVerifiedAt = kyc.level1.bvnVerifiedAt;
        user.ninVerifiedAt = verifiedAt;
        user.kycVerifiedAt = verifiedAt;
        await Promise.all([kyc.save(), user.save()]);
        try {
            await walletRoutes.createDedicatedAccountForUser(user._id);
        } catch (accountError) {
            return reply.code(502).send({
                success: false,
                kycVerified: true,
                message: accountError.message || 'KYC was verified, but your dedicated account could not be created yet.'
            });
        }

        return reply.send({
            success: true,
            message: 'KYC Verified - BVN and NIN Verified - Your dedicated account has been created',
        });
    } catch (error) {
        handleError(reply, error, 'Unable to verify KYC.');
    }
}

/* =========================================================================
   SUBMIT LEVEL 1: LEGACY MANUAL BACKEND LOGIC
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

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) kyc = new KYC({ user: request.user._id });

        if (kyc.currentLevel === 1 && kyc.status === 'under_review') {
            throw new Error('Your Tier 1 submission is already under review.');
        }

        kyc.currentLevel = 1; 
        await kyc.submitLevel1(encrypt(bvn), nin ? encrypt(nin) : null, bvn ? bvn.slice(-4) : null, nin ? nin.slice(-4) : null);

        // Instantly mark as under review for Admin processing
        kyc.status = 'under_review';
        if (kyc.level1) kyc.level1.status = 'under_review';
        if (firstName && lastName) kyc.legalName = `${firstName} ${lastName}`;
        await kyc.save();

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

module.exports = { getKYC, verifyKYC, submitLevel1, submitLevel2, submitLevel3 };
