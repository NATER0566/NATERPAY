const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
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

// [3] BULLETPROOF CENTRALIZED ERROR HANDLING (FIXED TO PREVENT UNHANDLED EXCEPTIONS)
function handleError(reply, error, defaultMessage = 'System error occurred.') {
    try {
        if (error && error.isJoi) {
            return reply.status(400).send({ success: false, message: error.details[0].message });
        }
        
        const msg = (error && error.message) ? error.message : defaultMessage;
        const stat = (error && error.status) ? error.status : 400;
        
        // Safely log the error without crashing Pino
        if (logger && typeof logger.error === 'function') {
            logger.error(msg, error || {});
        }
        
        return reply.status(stat).send({ success: false, message: msg });
    } catch (fatalErr) {
        // Failsafe: If the error handler itself fails, send a 500 without crashing the server
        return reply.status(500).send({ success: false, message: 'A critical backend execution error occurred.' });
    }
}

// [4] TEXT SANITIZATION (Critical XSS Protection for Admin Dashboard)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim().substring(0, 2000) : '';

/* =========================================================================
   [5] REDIS RATE LIMITING ENGINE (Anti-Spam & DDoS Protection)
========================================================================= */
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;
const fallbackRateLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of fallbackRateLimits.entries()) {
        if (now > data.resetTime) fallbackRateLimits.delete(key);
    }
}, 60000);

async function checkRateLimit(request, action, limit = 10) {
    // Safely resolve the user ID to prevent undefined crashes
    const userId = request.user ? (request.user._id || request.user.id || 'unknown') : null;
    const identifier = userId || request.ip || 'anonymous';
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
   [6] IMMUTABLE AUDIT LOGGING ENGINE (FIXED DATA TYPES TO PREVENT DB CRASH)
========================================================================= */
async function createAuditLog(params) {
    if (!AuditLog) return;
    try {
        const logEntry = new AuditLog({
            user: params.user || undefined, 
            transactionReference: params.reference || 'SUPPORT_ACTION',
            amount: 0, 
            type: 'support_action', 
            previousBalance: 0, // FIXED: Now sent as Number instead of String '0'
            newBalance: 0,      // FIXED: Now sent as Number instead of String '0'
            ipAddress: params.ipAddress || '0.0.0.0', 
            userAgent: params.userAgent || 'System',
            status: 'success', 
            source: 'Support API', 
            details: { action: params.action || 'Ticket Generated' }
        });
        await logEntry.save();
    } catch(e) { 
        if (logger) logger.error('Audit Log Schema Error', e); 
    }
}

/* ============================================================================
   1. GET USER'S SUPPORT TICKETS
============================================================================ */
async function getTickets(request, reply) {
    try {
        if (!await checkRateLimit(request, 'fetch_tickets', 60)) throw { status: 429, message: 'Too many requests. Please slow down.' };

        const userId = request.user ? (request.user._id || request.user.id) : null;
        if (!userId) throw { status: 401, message: 'Authentication identity missing.' };

        let tickets = [];
        if (typeof SupportTicket.findByUser === 'function') {
            tickets = await SupportTicket.findByUser(userId);
        } else {
            tickets = await SupportTicket.find({ user: userId }).sort({ createdAt: -1 });
        }
        
        return reply.status(200).send({
            success: true,
            tickets: tickets.map(ticket => ({
                _id: ticket._id,
                ticketId: ticket.ticketId,
                subject: ticket.subject,
                category: ticket.category,
                priority: ticket.priority,
                status: ticket.status,
                createdAt: ticket.createdAt,
                resolvedAt: ticket.resolvedAt
            }))
        });
    } catch (error) { return handleError(reply, error, 'Failed to fetch support tickets'); }
}

/* ============================================================================
   2. CREATE SUPPORT TICKET (XSS PROTECTED & FULLY BULLETPROOF)
============================================================================ */
async function createTicket(request, reply) {
    try {
        if (!await checkRateLimit(request, 'create_ticket', 5)) throw { status: 429, message: 'Too many tickets created recently. Please wait.' };

        const userId = request.user ? (request.user._id || request.user.id) : null;
        if (!userId) throw { status: 401, message: 'Authentication identity missing.' };

        const schema = Joi.object({
            ticketId: Joi.string().optional(),
            subject: Joi.string().min(3).max(150).required(),
            category: Joi.string().required(),
            priority: Joi.string().valid('low', 'medium', 'high', 'urgent', 'Low', 'Medium', 'High', 'Urgent').default('medium'),
            description: Joi.string().min(10).required(),
            relatedTransaction: Joi.string().allow('', null).optional()
        }).unknown(true);

        const { error, value } = schema.validate(request.body);
        if (error) throw error;
        
        const finalTicketId = value.ticketId || ('TKT-' + Math.floor(10000000 + Math.random() * 90000000));

        // Enforces lowercase strictly so "Funding" does not break strict Database Enums
        const safeCategory = String(value.category || 'other').toLowerCase(); 
        const safePriority = String(value.priority || 'medium').toLowerCase();

        let safeRelatedTx = value.relatedTransaction;
        let finalDescription = value.description;
        
        if (safeRelatedTx && !mongoose.Types.ObjectId.isValid(safeRelatedTx)) {
            finalDescription = `[Transaction Reference Provided: ${safeRelatedTx}]\n\n${finalDescription}`;
            safeRelatedTx = undefined;
        }

        const ticket = new SupportTicket({
            ticketId: finalTicketId,
            user: userId,
            subject: sanitizeText(value.subject),
            category: sanitizeText(safeCategory),
            priority: safePriority,
            description: sanitizeText(finalDescription),
            relatedTransaction: safeRelatedTx || undefined
        });
        
        await ticket.save();
        
        if (Notification && typeof Notification.create === 'function') {
            await Notification.create({
                user: userId, title: 'Support Ticket Created',
                message: `Your support ticket ${ticket.ticketId} has been created`, type: 'support', priority: 'medium'
            }).catch(() => {}); // Fails silently to prevent unhandled rejections
        }

        await createAuditLog({ 
            user: userId, 
            reference: ticket.ticketId, 
            action: 'Created Support Ticket', 
            ipAddress: request.ip, 
            userAgent: request.headers ? request.headers['user-agent'] : 'System' 
        });
        
        return reply.status(201).send({
            success: true,
            message: 'Support ticket created successfully',
            ticket: { _id: ticket._id, ticketId: ticket.ticketId }
        });
    } catch (error) { return handleError(reply, error, 'Failed to create support ticket'); }
}

/* ============================================================================
   3. GET SINGLE TICKET DOSSIER WITH MESSAGES
============================================================================ */
async function getTicket(request, reply) {
    try {
        if (!await checkRateLimit(request, 'fetch_single_ticket', 60)) throw { status: 429, message: 'Too many requests.' };

        const userId = request.user ? (request.user._id || request.user.id) : null;
        if (!userId) throw { status: 401, message: 'Authentication identity missing.' };

        const { ticketId } = request.params;
        const safeTicketId = sanitizeText(ticketId);
        
        let ticket = null;
        if (typeof SupportTicket.findByTicketId === 'function') {
            ticket = await SupportTicket.findByTicketId(safeTicketId);
        } else {
            ticket = await SupportTicket.findOne({ ticketId: safeTicketId });
        }
        
        if (!ticket) throw { status: 404, message: 'Ticket not found' };
        
        const userRole = (request.user.role || 'user').toLowerCase();
        
        // Safely ensure user owns the ticket OR is an admin
        const ticketOwnerStr = ticket.user._id ? ticket.user._id.toString() : ticket.user.toString();
        if (ticketOwnerStr !== userId.toString() && !['admin', 'superadmin'].includes(userRole)) {
            throw { status: 403, message: 'Access denied. You do not own this ticket.' };
        }
        
        return reply.status(200).send({
            success: true,
            ticket: {
                _id: ticket._id,
                ticketId: ticket.ticketId,
                subject: ticket.subject,
                category: ticket.category,
                priority: ticket.priority,
                description: ticket.description,
                status: ticket.status,
                assignedTo: ticket.assignedTo,
                assignedAt: ticket.assignedAt,
                resolution: ticket.resolution,
                resolvedAt: ticket.resolvedAt,
                relatedTransaction: ticket.relatedTransaction,
                createdAt: ticket.createdAt,
                messages: ticket.messages.map(msg => ({
                    _id: msg._id,
                    user: msg.user,
                    message: msg.message,
                    isInternal: msg.isInternal,
                    attachments: msg.attachments,
                    createdAt: msg.createdAt
                }))
            }
        });
    } catch (error) { return handleError(reply, error, 'Failed to fetch ticket details'); }
}

/* ============================================================================
   4. ADD MESSAGE TO TICKET
============================================================================ */
async function addMessage(request, reply) {
    try {
        if (!await checkRateLimit(request, 'add_ticket_message', 15)) throw { status: 429, message: 'Too many messages sent. Please wait.' };

        const userId = request.user ? (request.user._id || request.user.id) : null;
        if (!userId) throw { status: 401, message: 'Authentication identity missing.' };

        const schema = Joi.object({
            message: Joi.string().required(),
            isInternal: Joi.boolean().default(false),
            attachments: Joi.array().items(Joi.string().uri()).default([])
        });

        const { error, value } = schema.validate(request.body);
        if (error) throw error;

        const { ticketId } = request.params;
        const safeTicketId = sanitizeText(ticketId);
        
        let ticket = null;
        if (typeof SupportTicket.findByTicketId === 'function') {
            ticket = await SupportTicket.findByTicketId(safeTicketId);
        } else {
            ticket = await SupportTicket.findOne({ ticketId: safeTicketId });
        }
        
        if (!ticket) throw { status: 404, message: 'Ticket not found' };
        
        const userRole = (request.user.role || 'user').toLowerCase();
        const ticketOwnerStr = ticket.user._id ? ticket.user._id.toString() : ticket.user.toString();
        
        if (ticketOwnerStr !== userId.toString() && !['admin', 'superadmin'].includes(userRole)) {
            throw { status: 403, message: 'Access denied. You do not own this ticket.' };
        }
        
        const safeMessage = sanitizeText(value.message);

        if (typeof ticket.addMessage === 'function') {
            await ticket.addMessage(userId, safeMessage, value.isInternal, value.attachments);
        } else {
            ticket.messages.push({ user: userId, message: safeMessage, isInternal: value.isInternal, attachments: value.attachments });
            await ticket.save();
        }
        
        // Reopen ticket if a user replies to a resolved ticket
        if (ticketOwnerStr === userId.toString() && ticket.status === 'resolved') {
            if (typeof ticket.reopen === 'function') {
                await ticket.reopen();
            } else {
                ticket.status = 'open';
                await ticket.save();
            }
        }
        
        if (Notification && typeof Notification.create === 'function') {
            await Notification.create({
                user: ticketOwnerStr, title: 'New Message on Ticket',
                message: `A new message has been added to ticket ${ticket.ticketId}`, type: 'support', priority: 'medium'
            }).catch(() => {});
        }

        await createAuditLog({ 
            user: userId, 
            reference: ticket.ticketId, 
            action: 'Added Message to Ticket', 
            ipAddress: request.ip, 
            userAgent: request.headers ? request.headers['user-agent'] : 'System' 
        });
        
        return reply.status(200).send({ success: true, message: 'Message added successfully' });
    } catch (error) { return handleError(reply, error, 'Failed to add message'); }
}

module.exports = {
  getTickets,
  createTicket,
  getTicket,
  addMessage
};
