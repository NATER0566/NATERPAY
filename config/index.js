
require('dotenv').config();
const Joi = require('joi');

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================
let logger;

try {
    logger = require('pino')();
} catch (e) {
    logger = {
        info: (msg) => console.log(JSON.stringify({
            level: 'info',
            timestamp: new Date().toISOString(),
            message: msg
        })),
        warn: (msg) => console.warn(JSON.stringify({
            level: 'warn',
            timestamp: new Date().toISOString(),
            message: msg
        })),
        error: (msg) => console.error(JSON.stringify({
            level: 'error',
            timestamp: new Date().toISOString(),
            message: msg
        }))
    };
}

// ============================================================================
// BOOLEAN PARSER
// ============================================================================
const checkBool = (val, fallback = false) => {
    if (val === undefined || val === null || val === '') return fallback;
    return String(val).toLowerCase().trim() === 'true';
};

// ============================================================================
// ENVIRONMENT VALIDATION
// Flutterwave credentials are checked when payment operations are requested.
// They remain optional at boot so health checks and the web server can start.
// ============================================================================
const optionalSecret = Joi.string().trim().allow('').optional();

const envVarsSchema = Joi.object({
    NODE_ENV: Joi.string()
        .valid('development', 'production', 'test')
        .default('production'),

    PORT: Joi.number().port().default(3000),
    HOST: Joi.string().default('0.0.0.0'),

    MONGODB_URI: Joi.string().trim().required(),

    JWT_SECRET: Joi.string().required(),
    JWT_REFRESH_SECRET: Joi.string().required(),
    JWT_EXPIRES_IN: Joi.string().default('1h'),
    JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

    // Cloud services
    CLOUDINARY_CLOUD_NAME: Joi.string().optional(),
    CLOUDINARY_API_KEY: Joi.string().optional(),
    CLOUDINARY_API_SECRET: Joi.string().optional(),

    // Email
    RESEND_API_KEY: Joi.string().optional(),
    FROM_EMAIL: Joi.string().email().optional(),

    // Flutterwave LIVE credentials
    // Payment credentials are checked when a payment operation is requested.
    // Their absence must not prevent health checks and the web server from booting.
    FLUTTERWAVE_SECRET_KEY: optionalSecret,
    FLUTTERWAVE_PUBLIC_KEY: optionalSecret,
    FLUTTERWAVE_SECRET_HASH: optionalSecret,
    FLUTTERWAVE_ENCRYPTION_KEY: optionalSecret,

    // VTpass
    VTPASS_API_KEY: Joi.string().optional(),
    VTPASS_SECRET_KEY: Joi.string().optional(),
    VTPASS_PUBLIC_KEY: Joi.string().optional(),
    VTPASS_URL: Joi.string()
        .trim()
        .default('https://sandbox.vtpass.com/api'),

    // Redis
    REDIS_URL: Joi.string().optional(),

    // Rate limiting
    RATE_LIMIT_WINDOW: Joi.number().integer().positive().default(900000),
    RATE_LIMIT_MAX: Joi.number().integer().positive().default(100),

    // Security
    BCRYPT_ROUNDS: Joi.number().integer().min(8).max(15).default(12),
    MAX_LOGIN_ATTEMPTS: Joi.number().integer().positive().default(5),
    LOCKOUT_DURATION: Joi.number().integer().positive().default(30),
    SESSION_TIMEOUT: Joi.number().integer().positive().default(1800),
    OTP_EXPIRY: Joi.number().integer().positive().default(300),

    // Business settings
    DEFAULT_REFERRAL_BONUS: Joi.number().min(0).default(50),
    MIN_WITHDRAWAL: Joi.number().min(0).default(100),
    MAX_WITHDRAWAL: Joi.number().min(0).default(500000),
    TRANSACTION_FEE_PERCENTAGE: Joi.number().min(0).default(1.5),

    // Feature flags
    ENABLE_WALLET: Joi.string().optional(),
    ENABLE_LOANS: Joi.string().optional(),
    ENABLE_SAVINGS: Joi.string().optional(),
    ENABLE_ESCROW: Joi.string().optional(),
    ENABLE_VIRTUAL_CARDS: Joi.string().optional(),
    ENABLE_AGENT_BANKING: Joi.string().optional(),
    ENABLE_TASK_EARN: Joi.string().optional(),
    ENABLE_DAILY_REWARDS: Joi.string().optional(),
    ENABLE_SPIN_WIN: Joi.string().optional(),
    ENABLE_AIRTIME_CASH: Joi.string().optional()

}).unknown(true).required();

const { error, value: envVars } = envVarsSchema.validate(process.env, {
    abortEarly: false,
    convert: true
});

if (error) {
    logger.error(
        `[CRITICAL BOOT ERROR] Environment validation failed: ${error.message}`
    );
    process.exit(1);
}

// ============================================================================
// EXPORTED CONFIGURATION
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
        // Flutterwave is the active payment integration.
        // This application is configured for LIVE mode.
        flutterwave: {
            mode: 'live',
            baseUrl: 'https://api.flutterwave.com/v3',

            secretKey: envVars.FLUTTERWAVE_SECRET_KEY,
            publicKey: envVars.FLUTTERWAVE_PUBLIC_KEY,
            secretHash: envVars.FLUTTERWAVE_SECRET_HASH,
            encryptionKey: envVars.FLUTTERWAVE_ENCRYPTION_KEY,
        },

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

    rateLimit: {
        windowMs: envVars.RATE_LIMIT_WINDOW,
        max: envVars.RATE_LIMIT_MAX
    },

    featureFlags: {
        wallet: checkBool(envVars.ENABLE_WALLET, true),
        loans: checkBool(envVars.ENABLE_LOANS),
        savings: checkBool(envVars.ENABLE_SAVINGS),
        escrow: checkBool(envVars.ENABLE_ESCROW),
        virtualCards: checkBool(envVars.ENABLE_VIRTUAL_CARDS),
        agentBanking: checkBool(envVars.ENABLE_AGENT_BANKING),
        taskEarn: checkBool(envVars.ENABLE_TASK_EARN, true),
        dailyRewards: checkBool(envVars.ENABLE_DAILY_REWARDS),
        spinWin: checkBool(envVars.ENABLE_SPIN_WIN),
        airtimeCash: checkBool(envVars.ENABLE_AIRTIME_CASH)
    },

    security: {
        bcryptRounds: envVars.BCRYPT_ROUNDS,
        maxLoginAttempts: envVars.MAX_LOGIN_ATTEMPTS,
        lockoutDuration: envVars.LOCKOUT_DURATION,
        sessionTimeout: envVars.SESSION_TIMEOUT,
        otpExpiry: envVars.OTP_EXPIRY
    },

    business: {
        defaultReferralBonus: envVars.DEFAULT_REFERRAL_BONUS,
        minWithdrawal: envVars.MIN_WITHDRAWAL,
        maxWithdrawal: envVars.MAX_WITHDRAWAL,
        transactionFeePercentage: envVars.TRANSACTION_FEE_PERCENTAGE
    }
};

logger.info(
    '[CONFIG] Environment variables validated. Secret values masked.'
);

const missingFlutterwave = [
    'FLUTTERWAVE_SECRET_KEY',
    'FLUTTERWAVE_PUBLIC_KEY',
    'FLUTTERWAVE_SECRET_HASH'
].filter((name) => !envVars[name]);

if (missingFlutterwave.length > 0) {
    logger.warn(
        `[CONFIG] Flutterwave is not fully configured. Missing: ${missingFlutterwave.join(', ')}.`
    );
}

module.exports = config;
