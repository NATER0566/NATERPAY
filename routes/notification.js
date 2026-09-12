const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const Joi = require('joi'); 

let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

let Redis;
try { Redis = require('ioredis'); } catch(e) {}
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action = 'read_notif', limit = 60) {
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

function handleError(reply, error, defaultMessage = 'System error occurred.') {
    if (error.isJoi) {
        return reply.status(400).send({ success: false, message: error.details[0].message });
    }
    logger.error(error.message, error);
    reply.status(error.status || 500).send({ success: false, message: error.message || defaultMessage });
}

const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim() : '';

/* =========================================================================
   GET USER NOTIFICATIONS
========================================================================= */
async function getNotifications(request, reply) {
    try {
        const schema = Joi.object({
            unreadOnly: Joi.string().valid('true', 'false').optional(),
            type: Joi.string().optional(),
            limit: Joi.number().integer().min(1).max(200).default(50)
        });
        const { error, value } = schema.validate(request.query);
        if (error) throw error;

        if (!await checkRateLimit(request, 'fetch_notifs', 120)) throw { status: 429, message: 'Too Many Requests.' };

        // [FIX] Query for User's personal notifications OR Global announcements
        const query = {
            $or: [
                { user: request.user._id },
                { isGlobal: true }
            ]
        };
        
        if (value.unreadOnly === 'true') query.isRead = false;
        if (value.type) query.type = sanitizeText(value.type);
        
        const notifications = await Notification.find(query).sort({ createdAt: -1 }).limit(value.limit);
        const unreadCount = await Notification.countDocuments({ user: request.user._id, isRead: false });
        
        reply.send({
            success: true,
            notifications: notifications.map(notif => ({
                _id: notif._id,
                title: notif.title,
                message: notif.message,
                image: notif.image,       // [FIX] ADDED IMAGE SO FRONTEND CAN SEE IT
                isGlobal: notif.isGlobal, // [FIX] ADDED ISGLOBAL FLAG
                type: notif.type,
                priority: notif.priority,
                actionLink: notif.actionLink,
                actionLabel: notif.actionLabel,
                isRead: notif.isRead,
                readAt: notif.readAt,
                createdAt: notif.createdAt
            })),
            unreadCount
        });
    } catch (error) { handleError(reply, error, 'Failed to fetch notifications'); }
}

/* =========================================================================
   MARK NOTIFICATION AS READ
========================================================================= */
async function markAsRead(request, reply) {
    try {
        const schema = Joi.object({ id: Joi.string().required() });
        const { error, value } = schema.validate(request.params);
        if (error) throw error;

        if (!await checkRateLimit(request, 'read_notif', 120)) throw { status: 429, message: 'Too Many Requests.' };

        const notification = await Notification.findOne({
            _id: sanitizeText(value.id),
            user: request.user._id
        });
        
        if (!notification) throw { status: 404, message: 'Notification not found' };
        
        if (typeof notification.markAsRead === 'function') {
            await notification.markAsRead();
        } else {
            notification.isRead = true;
            notification.readAt = new Date();
            await notification.save();
        }
        
        reply.send({ success: true, message: 'Notification marked as read' });
    } catch (error) { handleError(reply, error, 'Failed to mark notification as read'); }
}

/* =========================================================================
   MARK ALL NOTIFICATIONS AS READ
========================================================================= */
async function markAllAsRead(request, reply) {
    try {
        if (!await checkRateLimit(request, 'read_all_notifs', 20)) throw { status: 429, message: 'Too Many Requests.' };

        if (typeof Notification.markAllAsRead === 'function') {
            await Notification.markAllAsRead(request.user._id);
        } else {
            await Notification.updateMany(
                { user: request.user._id, isRead: false },
                { $set: { isRead: true, readAt: new Date() } }
            );
        }
        
        reply.send({ success: true, message: 'All notifications marked as read' });
    } catch (error) { handleError(reply, error, 'Failed to mark all notifications as read'); }
}

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead
};
