const mongoose = require('mongoose');
const CMS = require('../models/CMS');
const cloudinary = require('cloudinary').v2;
const Joi = require('joi'); // [1] Strict Request Validation

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

let AuditLog, Redis;
try { AuditLog = require('../models/AuditLog'); } catch(e) {}
try { Redis = require('ioredis'); } catch(e) {}

// [3] CENTRALIZED ERROR HANDLING
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) return reply.status(400).send({ success: false, message: error.details[0].message });
    logger.error(error.message, error);
    reply.status(error.status || 400).send({ success: false, message: error.message || defaultMessage });
}

// [4] TEXT SANITIZATION (Critical XSS Protection for CMS)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim() : '';

/* =========================================================================
   [5] REDIS RATE LIMITING ENGINE (Anti-Scraping & DDoS Protection)
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 60) {
    const identifier = request.user ? request.user._id : request.ip;
    const windowSeconds = 60;

    const executeFallback = () => {
        const now = Date.now();
        const key = `rate_${action}_${identifier}`;
        if (!fallbackRateLimits.has(key)) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        const data = fallbackRateLimits.get(key);
        if (now > data.resetTime) {
            fallbackRateLimits.set(key, { count: 1, resetTime: now + (windowSeconds * 1000) });
            return true;
        }
        if (data.count >= limit) return false;
        data.count++;
        return true;
    };

    if (redisClient && redisClient.status === 'ready') {
        try {
            const key = `rate:${action}:${identifier}`;
            const count = await redisClient.incr(key);
            if (count === 1) await redisClient.expire(key, windowSeconds);
            return count <= limit;
        } catch (err) { return executeFallback(); }
    } else { return executeFallback(); }
}

/* =========================================================================
   [6] CLOUDINARY UPLOAD WITH NETWORK RETRY
========================================================================= */
async function uploadToCloudinaryWithRetry(mediaData, resourceType, folder, retries = 3) {
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });
    } else {
        return mediaData; // Fallback to raw data if Cloudinary isn't configured
    }

    for (let i = 0; i < retries; i++) {
        try {
            const uploadRes = await cloudinary.uploader.upload(mediaData, { resource_type: resourceType, folder: folder, timeout: 20000 });
            return uploadRes.secure_url;
        } catch (err) {
            if (i === retries - 1) throw new Error('Cloudinary upload failed after retries.');
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
}

/* =========================================================================
   IMMUTABLE AUDIT LOGGING ENGINE
========================================================================= */
async function createAuditLog(params) {
    if (!AuditLog) return;
    try {
        await new AuditLog({
            user: params.user, transactionId: null, transactionReference: `CMS-${Date.now()}`,
            amount: 0, type: 'cms_update', previousBalance: '0', newBalance: '0', 
            ipAddress: params.ipAddress, userAgent: params.userAgent,
            status: 'success', source: 'Admin CMS Engine', details: { action: params.action }
        }).save();
    } catch(e) { logger.error('Audit Log Error', e); }
}

/* ============================================================================
   GET HOMEPAGE DATA (PUBLIC)
============================================================================ */
async function getHomepageData(request, reply) {
    try {
        if (!await checkRateLimit(request, 'cms_homepage', 60)) throw { status: 429, message: 'Too many requests.' };

        const data = await CMS.getHomepageData();
        reply.send({
            success: true,
            data: data?.homepage || {
                siteName: 'NATER-PAY', logoUrl: null, tagline: 'Enterprise Fintech Services Platform',
                rates: { mtn: 215, airtel: 190, glo: 220, nineMobile: 180 }
            }
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch homepage data'); }
}

/* ============================================================================
   GET SLIDES (PUBLIC & ADMIN)
============================================================================ */
async function getSlides(request, reply) {
    try {
        if (!await checkRateLimit(request, 'cms_slides', 60)) throw { status: 429, message: 'Too many requests.' };

        const rawSlides = await CMS.getActiveSlides();
        const cleanSlides = (rawSlides || []).map(slide => ({
            _id: slide._id, title: slide.title, caption: slide.caption || 'Welcome to the NATER-PAY ecosystem.',
            mediaUrl: slide.mediaUrl || slide.imageUrl, imageUrl: slide.mediaUrl || slide.imageUrl,
            type: slide.type || slide.mediaType || 'image', ctaText: slide.ctaText || 'EXPLORE NOW',
            ctaLink: slide.ctaLink || slide.link || '#authTitle', link: slide.ctaLink || slide.link || '#authTitle'
        }));

        reply.send({ success: true, data: cleanSlides, slides: cleanSlides });
    } catch (error) { handleError(reply, error, 'Failed to fetch slides'); }
}

/* ============================================================================
   UPDATE HOMEPAGE (ADMIN)
============================================================================ */
async function updateHomepage(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_update_homepage', 10)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            siteName: Joi.string().required(), logoUrl: Joi.string().allow('', null),
            tagline: Joi.string().allow('', null), rates: Joi.object().optional()
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;
        
        await CMS.updateHomepage({ 
            siteName: sanitizeText(value.siteName), logoUrl: value.logoUrl, tagline: sanitizeText(value.tagline), rates: value.rates 
        });
        
        await createAuditLog({ user: request.user._id, action: 'Updated Homepage settings', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        if (request.server.io) request.server.io.emit('cms_update');
        reply.send({ success: true, message: 'Homepage updated successfully' });
    } catch (error) { handleError(reply, error, 'Failed to update homepage'); }
}

/* ============================================================================
   ADD SLIDE (ADMIN) WITH CLOUDINARY ENGINE
============================================================================ */
async function addSlide(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_add_slide', 10)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            title: Joi.string().required(), caption: Joi.string().allow('', null),
            ctaText: Joi.string().allow('', null), link: Joi.string().allow('', null),
            type: Joi.string().valid('image', 'video', 'text').default('image'),
            mediaData: Joi.string().allow('', null), order: Joi.number().default(0)
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        let finalMediaUrl = '';
        if (value.mediaData && value.type !== 'text') {
            finalMediaUrl = await uploadToCloudinaryWithRetry(value.mediaData, value.type === 'video' ? 'video' : 'image', 'naterpay/slides');
        }
        
        await CMS.addSlide({
            title: sanitizeText(value.title), caption: sanitizeText(value.caption), type: value.type, mediaType: value.type,
            mediaUrl: finalMediaUrl, imageUrl: finalMediaUrl, ctaText: sanitizeText(value.ctaText) || 'EXPLORE NOW',
            ctaLink: sanitizeText(value.link) || '#', link: sanitizeText(value.link) || '#', order: value.order
        });
        
        await createAuditLog({ user: request.user._id, action: `Added Slide: ${value.title}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        if (request.server.io) request.server.io.emit('slides_refresh');
        
        reply.send({ success: true, message: 'Slide published successfully' });
    } catch (error) { handleError(reply, error, 'Failed to add slide'); }
}

/* ============================================================================
   UPDATE SLIDE (ADMIN)
============================================================================ */
async function updateSlide(request, reply) {
    try {
        const { id } = request.params;
        const updateData = {};
        if (request.body.title !== undefined) updateData.title = sanitizeText(request.body.title);
        if (request.body.caption !== undefined) updateData.caption = sanitizeText(request.body.caption);
        if (request.body.type !== undefined) updateData.type = request.body.type;
        if (request.body.mediaType !== undefined) updateData.mediaType = request.body.mediaType;
        if (request.body.ctaText !== undefined) updateData.ctaText = sanitizeText(request.body.ctaText);
        if (request.body.ctaLink !== undefined) updateData.ctaLink = sanitizeText(request.body.ctaLink);
        if (request.body.isActive !== undefined) updateData.isActive = request.body.isActive;
        
        await CMS.updateSlide(id, updateData);
        await createAuditLog({ user: request.user._id, action: `Updated Slide: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        
        if (request.server.io) request.server.io.emit('slides_refresh');
        reply.send({ success: true, message: 'Slide updated successfully' });
    } catch (error) { handleError(reply, error, 'Failed to update slide'); }
}

/* ============================================================================
   DELETE SLIDE (ADMIN)
============================================================================ */
async function deleteSlide(request, reply) {
    try {
        const { id } = request.params;
        await CMS.deleteSlide(id);
        
        await createAuditLog({ user: request.user._id, action: `Deleted Slide: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        if (request.server.io) request.server.io.emit('slides_refresh');
        
        reply.send({ success: true, message: 'Slide deleted successfully' });
    } catch (error) { handleError(reply, error, 'Failed to delete slide'); }
}

/* ============================================================================
   ANNOUNCEMENTS ENGINE (PUBLIC & ADMIN)
============================================================================ */
async function getAnnouncements(request, reply) {
    try {
        if (!await checkRateLimit(request, 'cms_announcements', 60)) throw { status: 429, message: 'Too many requests.' };
        const announcements = await CMS.getActiveAnnouncements(request.query.targetAudience || 'all');
        reply.send({ success: true, data: announcements });
    } catch (error) { handleError(reply, error, 'Failed to fetch announcements'); }
}

async function addAnnouncement(request, reply) {
    try {
        const schema = Joi.object({
            title: Joi.string().required(), message: Joi.string().required(), type: Joi.string().default('info'),
            isActive: Joi.boolean().default(true), startDate: Joi.date().allow('', null), endDate: Joi.date().allow('', null), targetAudience: Joi.string().default('all')
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;
        
        await CMS.addAnnouncement({
            title: sanitizeText(value.title), message: sanitizeText(value.message), type: value.type, isActive: value.isActive,
            startDate: value.startDate ? new Date(value.startDate) : null, endDate: value.endDate ? new Date(value.endDate) : null, targetAudience: value.targetAudience
        });
        
        await createAuditLog({ user: request.user._id, action: `Created Announcement: ${value.title}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Announcement added successfully' });
    } catch (error) { handleError(reply, error, 'Failed to add announcement'); }
}

async function updateAnnouncement(request, reply) {
    try {
        const { id } = request.params;
        const { title, message, type, isActive, startDate, endDate, targetAudience } = request.body;
        
        await CMS.updateAnnouncement(id, {
            title: sanitizeText(title), message: sanitizeText(message), type, isActive,
            startDate: startDate ? new Date(startDate) : null, endDate: endDate ? new Date(endDate) : null, targetAudience
        });
        await createAuditLog({ user: request.user._id, action: `Updated Announcement: ${id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Announcement updated successfully' });
    } catch (error) { handleError(reply, error, 'Failed to update announcement'); }
}

async function deleteAnnouncement(request, reply) {
    try {
        await CMS.deleteAnnouncement(request.params.id);
        await createAuditLog({ user: request.user._id, action: `Deleted Announcement: ${request.params.id}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Announcement deleted successfully' });
    } catch (error) { handleError(reply, error, 'Failed to delete announcement'); }
}

async function setMaintenanceMode(request, reply) {
    try {
        const { enabled, message, scheduledStart, scheduledEnd } = request.body;
        await CMS.setMaintenanceMode( enabled, sanitizeText(message), scheduledStart ? new Date(scheduledStart) : null, scheduledEnd ? new Date(scheduledEnd) : null );
        await createAuditLog({ user: request.user._id, action: `Toggled Maintenance Mode: ${enabled}`, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        reply.send({ success: true, message: 'Maintenance mode updated successfully' });
    } catch (error) { handleError(reply, error, 'Failed to update maintenance mode'); }
}

/* ============================================================================
   FOUNDER PROFILE ENGINE (PUBLIC & ADMIN)
============================================================================ */
async function getFounderProfile(request, reply) {
    try {
        if (!await checkRateLimit(request, 'cms_founder', 60)) throw { status: 429, message: 'Too many requests.' };
        const cmsData = await CMS.findOne();
        reply.send({ 
            success: true, 
            founder: cmsData?.founderProfile || {
                name: 'Nater Mbashau', title: 'Chief Executive Officer & Lead Architect',
                academic: '300L Computer Science • Nasarawa State University, Keffi',
                bio: 'Operating under the professional architecture of NATER GRACE CODE...', photoUrl: ''
            } 
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch founder profile'); }
}

async function updateFounderProfile(request, reply) {
    try {
        if (!await checkRateLimit(request, 'admin_founder_update', 10)) throw { status: 429, message: 'Too many requests.' };

        const schema = Joi.object({
            name: Joi.string().required(), title: Joi.string().required(),
            academic: Joi.string().required(), bio: Joi.string().required(), mediaData: Joi.string().allow('', null)
        });
        const { error, value } = schema.validate(request.body);
        if (error) throw error;
        
        let cmsData = await CMS.findOne();
        if (!cmsData) cmsData = new CMS();
        if (!cmsData.founderProfile) cmsData.founderProfile = {};

        cmsData.founderProfile.name = sanitizeText(value.name);
        cmsData.founderProfile.title = sanitizeText(value.title);
        cmsData.founderProfile.academic = sanitizeText(value.academic);
        cmsData.founderProfile.bio = sanitizeText(value.bio);

        if (value.mediaData && value.mediaData.startsWith('data:image')) {
            cmsData.founderProfile.photoUrl = await uploadToCloudinaryWithRetry(value.mediaData, 'image', 'naterpay/founder');
        }

        await cmsData.save();
        await createAuditLog({ user: request.user._id, action: 'Updated Founder Profile', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
        
        if (request.server.io) request.server.io.emit('cms_update');
        reply.send({ success: true, message: 'Founder profile updated successfully', founder: cmsData.founderProfile });
    } catch (error) { handleError(reply, error, 'Failed to update founder profile'); }
}

module.exports = {
  getHomepageData, getSlides, updateHomepage, addSlide, updateSlide, deleteSlide,
  getAnnouncements, addAnnouncement, updateAnnouncement, deleteAnnouncement, setMaintenanceMode,
  getFounderProfile, updateFounderProfile
};
