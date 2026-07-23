const { verifyAccessToken } = require('../utils/auth');
const User = require('../models/User');

// [1] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

// [2] REDIS CACHE ENGINE (For fast-failing suspended accounts)
let Redis;
try { Redis = require('ioredis'); } catch(e) {}
const redisClient = (Redis && process.env.REDIS_URL) ? new Redis(process.env.REDIS_URL) : null;

/* =========================================================================
   1. CORE AUTHENTICATION ENGINE
========================================================================= */
async function authenticate(request, reply) {
    try {
        const authHeader = request.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reply.status(401).send({ success: false, message: 'Authentication required. Invalid or missing Bearer token.' });
        }
        
        const token = authHeader.substring(7);
        
        // [3] ANTI-DoS PROTECTION: Reject absurdly large tokens instantly
        if (token.length > 2048) {
            logger.warn('Suspiciously large auth token rejected', { ip: request.ip });
            return reply.status(401).send({ success: false, message: 'Invalid token structure.' });
        }

        const decoded = verifyAccessToken(token);
        if (!decoded || !decoded.userId) {
            return reply.status(401).send({ success: false, message: 'Session expired or invalid. Please log in again.' });
        }
        
        // [4] FAST-FAIL CACHE: Block suspended users instantly without hitting MongoDB
        if (redisClient && redisClient.status === 'ready') {
            const isBlocked = await redisClient.get(`blacklist_${decoded.userId}`);
            if (isBlocked) {
                return reply.status(403).send({ success: false, message: 'Account suspended. Please contact support.' });
            }
        }

        const user = await User.findById(decoded.userId);
        
        if (!user) return reply.status(401).send({ success: false, message: 'User record not found.' });
        if (!user.isActive) return reply.status(403).send({ success: false, message: 'Account is deactivated.' });
        
        if (user.isSuspended) {
            // Add to Redis blacklist for 5 minutes to shield database from retry spam
            if (redisClient && redisClient.status === 'ready') {
                await redisClient.setex(`blacklist_${decoded.userId}`, 300, 'true').catch(() => null);
            }
            return reply.status(403).send({ success: false, message: `Account suspended: ${user.suspensionReason || 'Please contact support.'}` });
        }
        
        request.user = user;
        request.userId = user._id;
    } catch (error) {
        logger.error('Auth Middleware Crash', error);
        return reply.status(401).send({ success: false, message: 'Authentication failed due to a system error.' });
    }
}

/* =========================================================================
   2. ADMIN CLEARANCE ENGINES
========================================================================= */
async function authenticateAdmin(request, reply) {
    await authenticate(request, reply);
    
    // If authenticate() already sent an error, stop execution
    if (reply.sent) return;
    
    const role = (request.user.role || '').toLowerCase();
    if (!['admin', 'superadmin'].includes(role)) {
        logger.warn('Unauthorized Admin Access Attempt', { userId: request.user._id, ip: request.ip });
        return reply.status(403).send({ success: false, message: 'Security Alert: Administrator clearance required.' });
    }
}

async function authenticateSuperAdmin(request, reply) {
    await authenticate(request, reply);
    
    if (reply.sent) return;
    
    const role = (request.user.role || '').toLowerCase();
    if (role !== 'superadmin') {
        logger.warn('Unauthorized Super-Admin Access Attempt', { userId: request.user._id, ip: request.ip });
        return reply.status(403).send({ success: false, message: 'Security Alert: Super-Administrator clearance required.' });
    }
}

/* =========================================================================
   3. COMPLIANCE CLEARANCE ENGINE
========================================================================= */
function requireKYCLevel(minLevel = 1) {
    return async function(request, reply) {
        await authenticate(request, reply);
        
        if (reply.sent) return;
        
        const userKyc = request.user.kycLevel || 0;
        if (userKyc < minLevel) {
            return reply.status(403).send({
                success: false,
                message: `Compliance Alert: KYC Tier ${minLevel} identity verification is required to perform this action.`,
                requiredLevel: minLevel,
                currentLevel: userKyc
            });
        }
    };
}

/* =========================================================================
   4. PASSIVE AUTHENTICATION ENGINE
========================================================================= */
async function optionalAuthenticate(request, reply) {
    try {
        const authHeader = request.headers.authorization;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            
            // Protect against payload attacks silently
            if (token.length > 2048) return; 
            
            const decoded = verifyAccessToken(token);
            
            if (decoded && decoded.userId) {
                // Ignore fast-fail cache here, just hit DB if valid
                const user = await User.findById(decoded.userId);
                if (user && user.isActive && !user.isSuspended) {
                    request.user = user;
                    request.userId = user._id;
                }
            }
        }
    } catch (error) {
        // Silently fail for optional auth to ensure public data still loads
    }
}

module.exports = {
    authenticate,
    authenticateAdmin,
    authenticateSuperAdmin,
    requireKYCLevel,
    optionalAuthenticate
};
