require('dotenv').config();



console.log("MONGODB_URI =", process.env.MONGODB_URI);

const config = {
  env: process.env.NODE_ENV || 'production',
  port: parseInt(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  
  database: {
    uri: process.env.MONGODB_URI
  },
  
  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  },
  
  payment: {
    paystack: {
      secretKey: process.env.PAYSTACK_SECRET_KEY,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY
    },
    flutterwave: {
      secretKey: process.env.FLUTTERWAVE_SECRET_KEY,
      publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY
    },
    monnify: {
      apiKey: process.env.MONNIFY_API_KEY,
      secretKey: process.env.MONNIFY_SECRET_KEY,
      contractCode: process.env.MONNIFY_CONTRACT_CODE
    }
  },
  
  vtu: {
    vtpass: {
      username: process.env.VTPASS_USERNAME,
      password: process.env.VTPASS_PASSWORD
    },
    vtugate: {
      apiKey: process.env.VTUGATE_API_KEY,
      publicKey: process.env.VTUGATE_PUBLIC_KEY
    }
  },
  
  email: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM
  },
  
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET
  },
  
  sms: {
    apiKey: process.env.SMS_API_KEY,
    senderId: process.env.SMS_SENDER_ID
  },
  
  featureFlags: {
    wallet: process.env.ENABLE_WALLET === 'true',
    loans: process.env.ENABLE_LOANS === 'true',
    savings: process.env.ENABLE_SAVINGS === 'true',
    escrow: process.env.ENABLE_ESCROW === 'true',
    virtualCards: process.env.ENABLE_VIRTUAL_CARDS === 'true',
    agentBanking: process.env.ENABLE_AGENT_BANKING === 'true',
    taskEarn: process.env.ENABLE_TASK_EARN === 'true',
    dailyRewards: process.env.ENABLE_DAILY_REWARDS === 'true',
    spinWin: process.env.ENABLE_SPIN_WIN === 'true',
    airtimeCash: process.env.ENABLE_AIRTIME_CASH === 'true'
  },
  
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 12,
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5,
    lockoutDuration: parseInt(process.env.LOCKOUT_DURATION) || 30,
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 1800,
    otpExpiry: parseInt(process.env.OTP_EXPIRY) || 300
  },
  
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100
  },
  
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || null
  },
  
  admin: {
    email: process.env.ADMIN_EMAIL,
    phone: process.env.ADMIN_PHONE
  },
  
  business: {
    defaultReferralBonus: parseFloat(process.env.DEFAULT_REFERRAL_BONUS) || 100,
    minWithdrawal: parseFloat(process.env.MIN_WITHDRAWAL) || 1000,
    maxWithdrawal: parseFloat(process.env.MAX_WITHDRAWAL) || 500000,
    transactionFeePercentage: parseFloat(process.env.TRANSACTION_FEE_PERCENTAGE) || 1.5
  },
  
  cron: {
    reconciliation: process.env.CRON_RECONCILIATION || '*/30 * * * *',
    backup: process.env.CRON_BACKUP || '0 2 * * *',
    audit: process.env.CRON_AUDIT || '0 3 * * *'
  }
};

// Validate required environment variables
function validateConfig() {
  const required = ['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    if (config.env === 'production') {
      process.exit(1);
    }
  }
}

validateConfig();

module.exports = config;
