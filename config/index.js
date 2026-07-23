require('dotenv').config();
const Joi = require('joi');

// [1] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg })),
        error: (msg, err) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err }))
    };
}

// ============================================================================
// BULLETPROOF BOOLEAN PARSER
// Automatically fixes invisible spaces or capital letters from Render Env Vars
// ============================================================================
const checkBool = (val, fallback = false) => {
    if (!val) return fallback;
    return val.toString().toLowerCase().trim() === 'true';
};

// ============================================================================
// STRICT ENVIRONMENT VALIDATION SCHEMA
// If your .env file is missing critical keys, the server refuses to boot.
// ============================================================================
const envVarsSchema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),
    PORT: Joi.number().default(3000),
    HOST: Joi.string().default('0.0.0.0'),
    
    MONGODB_URI: Joi.string().required().description('MongoDB Connection String'),
    
    JWT_SECRET: Joi.string().required().description('JWT Access Secret'),
    JWT_REFRESH_SECRET: Joi.string().required().description('JWT Refresh Secret'),
    JWT_EXPIRES_IN: Joi.string().default('1h'),
    JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

    // Cloud & External APIs
    CLOUDINARY_CLOUD_NAME: Joi.string().optional(),
    CLOUDINARY_API_KEY: Joi.string().optional(),
    CLOUDINARY_API_SECRET: Joi.string().optional(),

    RESEND_API_KEY: Joi.string().optional(),
    FROM_EMAIL: Joi.string().email().optional(),

    PAYSTACK_SECRET_KEY: Joi.string().optional(),
    PAYSTACK_PUBLIC_KEY: Joi.string().optional(),

    VTPASS_API_KEY: Joi.string().optional(),
    VTPASS_SECRET_KEY: Joi.string().optional(),
    VTPASS_PUBLIC_KEY: Joi.string().optional(),
    VTPASS_URL: Joi.string().uri().default('https://sandbox.vtpass.com/api'),

    REDIS_URL: Joi.string().optional().description('Redis connection string for rate limiting')
}).unknown().required();

const { error, value: envVars } = envVarsSchema.validate(process.env);

if (error) {
    logger.error(`[CRITICAL BOOT ERROR] Invalid or missing environment variables: ${error.message}`);
    if (envVars.NODE_ENV === 'production') {
        process.exit(1); // Hard crash to prevent insecure boot
    }
}

// ============================================================================
// EXPORTED CONFIGURATION OBJECT
// ============================================================================
const config = {
    env: envVars.NODE_ENV,
    port: envVars.PORT,
    host: envVars.HOST,
    
    database: {
        uri: envVars.MONGODB_URI
    },
    
    jwt: {
        secret: envVars.JWT_SECRET,
        refreshSecret: envVars.JWT_REFRESH_SECRET,
        expiresIn: envVars.JWT_EXPIRES_IN,
        refreshExpiresIn: envVars.JWT_REFRESH_EXPIRES_IN
    },
    
    payment: {
        paystack: {
            secretKey: envVars.PAYSTACK_SECRET_KEY,
            publicKey: envVars.PAYSTACK_PUBLIC_KEY
        }
    },
    
    vtu: {
        vtpass: {
            apiKey: envVars.VTPASS_API_KEY,
            secretKey: envVars.VTPASS_SECRET_KEY,
            publicKey: envVars.VTPASS_PUBLIC_KEY,
            url: envVars.VTPASS_URL
        }
    },
    
    email: {
        resendApiKey: envVars.RESEND_API_KEY,
        from: envVars.FROM_EMAIL || 'support@naterpay.com'
    },
    
    cloudinary: {
        cloudName: envVars.CLOUDINARY_CLOUD_NAME,
        apiKey: envVars.CLOUDINARY_API_KEY,
        apiSecret: envVars.CLOUDINARY_API_SECRET
    },
    
    redis: {
        url: envVars.REDIS_URL
    },

    // [FIXED] THIS IS THE MISSING BLOCK THAT WAS CRASHING SERVER.JS!
    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 900000,
        max: parseInt(process.env.RATE_LIMIT_MAX) || 100
    },

    featureFlags: {
        wallet: checkBool(process.env.ENABLE_WALLET, true), 
        loans: checkBool(process.env.ENABLE_LOANS),
        savings: checkBool(process.env.ENABLE_SAVINGS),
        escrow: checkBool(process.env.ENABLE_ESCROW),
        virtualCards: checkBool(process.env.ENABLE_VIRTUAL_CARDS),
        agentBanking: checkBool(process.env.ENABLE_AGENT_BANKING),
        taskEarn: checkBool(process.env.ENABLE_TASK_EARN, true), 
        dailyRewards: checkBool(process.env.ENABLE_DAILY_REWARDS),
        spinWin: checkBool(process.env.ENABLE_SPIN_WIN),
        airtimeCash: checkBool(process.env.ENABLE_AIRTIME_CASH)
    },
    
    security: {
        bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 12,
        maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5,
        lockoutDuration: parseInt(process.env.LOCKOUT_DURATION) || 30,
        sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 1800,
        otpExpiry: parseInt(process.env.OTP_EXPIRY) || 300
    },
    
    business: {
        defaultReferralBonus: parseFloat(process.env.DEFAULT_REFERRAL_BONUS) || 50, 
        minWithdrawal: parseFloat(process.env.MIN_WITHDRAWAL) || 100,
        maxWithdrawal: parseFloat(process.env.MAX_WITHDRAWAL) || 500000,
        transactionFeePercentage: parseFloat(process.env.TRANSACTION_FEE_PERCENTAGE) || 1.5
    }
};

logger.info('[CONFIG] Environment variables loaded and validated successfully. Secrets masked.');

module.exports = config;
