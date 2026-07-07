const { verifyAccessToken } = require('../utils/auth');
const User = require('../models/User');

/**
 * Authentication middleware - verifies JWT token
 */
async function authenticate(request, reply) {
  try {
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        success: false,
        message: 'No authentication token provided'
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = verifyAccessToken(token);
    
    if (!decoded) {
      return reply.status(401).send({
        success: false,
        message: 'Invalid or expired token'
      });
    }
    
    const user = await User.findById(decoded.userId);
    
    if (!user || !user.isActive) {
      return reply.status(401).send({
        success: false,
        message: 'User not found or inactive'
      });
    }
    
    if (user.isSuspended) {
      return reply.status(403).send({
        success: false,
        message: 'Account suspended. Please contact support.'
      });
    }
    
    request.user = user;
    request.userId = user._id;
  } catch (error) {
    return reply.status(401).send({
      success: false,
      message: 'Authentication failed'
    });
  }
}

/**
 * Admin authentication middleware - verifies admin role
 */
async function authenticateAdmin(request, reply) {
  await authenticate(request, reply);
  
  if (reply.sent) return;
  
  if (!['admin', 'superadmin'].includes(request.user.role)) {
    return reply.status(403).send({
      success: false,
      message: 'Admin access required'
    });
  }
}

/**
 * Super admin authentication middleware
 */
async function authenticateSuperAdmin(request, reply) {
  await authenticate(request, reply);
  
  if (reply.sent) return;
  
  if (request.user.role !== 'superadmin') {
    return reply.status(403).send({
      success: false,
      message: 'Super admin access required'
    });
  }
}

/**
 * KYC level check middleware
 */
function requireKYCLevel(minLevel = 1) {
  return async function(request, reply) {
    await authenticate(request, reply);
    
    if (reply.sent) return;
    
    if (request.user.kycLevel < minLevel) {
      return reply.status(403).send({
        success: false,
        message: `KYC level ${minLevel} required for this action`,
        requiredLevel: minLevel,
        currentLevel: request.user.kycLevel
      });
    }
  };
}

/**
 * Optional authentication - doesn't fail if no token
 */
async function optionalAuthenticate(request, reply) {
  try {
    const authHeader = request.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = verifyAccessToken(token);
      
      if (decoded) {
        const user = await User.findById(decoded.userId);
        if (user && user.isActive && !user.isSuspended) {
          request.user = user;
          request.userId = user._id;
        }
      }
    }
  } catch (error) {
    // Ignore errors for optional auth
  }
}

module.exports = {
  authenticate,
  authenticateAdmin,
  authenticateSuperAdmin,
  requireKYCLevel,
  optionalAuthenticate
};
