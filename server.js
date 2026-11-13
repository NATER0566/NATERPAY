'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const cron = require('node-cron');
const config = require('./config');

// -----------------------------------------------------------------------------
// LOGGING
// -----------------------------------------------------------------------------
let logger;

try {
    logger = require('pino')();
} catch (error) {
    logger = {
        info: (message, meta = {}) => console.log(JSON.stringify({
            level: 'info', timestamp: new Date().toISOString(), message, ...meta
        })),
        warn: (message, meta = {}) => console.warn(JSON.stringify({
            level: 'warn', timestamp: new Date().toISOString(), message, ...meta
        })),
        error: (message, error, meta = {}) => console.error(JSON.stringify({
            level: 'error',
            timestamp: new Date().toISOString(),
            message,
            error: error?.message || error,
            ...meta
        }))
    };
}

// -----------------------------------------------------------------------------
// REDIS
// -----------------------------------------------------------------------------
let redisClient = null;

try {
    const Redis = require('ioredis');

    if (process.env.REDIS_URL) {
        // ioredis automatically enables TLS for rediss:// URLs. Do not disable
        // certificate validation: that would make the Redis connection weaker.
        redisClient = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: false
        });

        redisClient.on('connect', () => {
            logger.info('[SYSTEM] Redis connection established.');
        });

        redisClient.on('error', (error) => {
            logger.error('[REDIS] Connection error.', error);
        });
    }
} catch (error) {
    logger.warn('[SYSTEM] Redis is unavailable. Local rate-limit fallback will be used.');
}

// -----------------------------------------------------------------------------
// FASTIFY CORE
// -----------------------------------------------------------------------------
const fastify = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 15 * 1024 * 1024,
    requestTimeout: 30000
});

fastify.setErrorHandler((error, request, reply) => {
    logger.error('[HTTP ERROR]', error, {
        method: request.method,
        url: request.url
    });

    if (reply.sent) return;

    const statusCode = Number(error.statusCode);
    if (statusCode >= 400 && statusCode < 500) {
        return reply.status(statusCode).send({
            success: false,
            message: statusCode === 400
                ? 'The request could not be processed. Check the submitted information.'
                : error.message || 'The request was rejected.'
        });
    }

    if (
        error.name === 'MongoServerSelectionError' ||
        error.name === 'MongooseServerSelectionError' ||
        error.name === 'MongooseError'
    ) {
        return reply.status(503).send({
            success: false,
            message: 'The database is temporarily unavailable. Please try again shortly.'
        });
    }

    return reply.status(500).send({
        success: false,
        message: 'An unexpected server error occurred. Please try again.'
    });
});

// -----------------------------------------------------------------------------
// DATABASE
// -----------------------------------------------------------------------------
async function connectDatabase() {
    mongoose.connection.on('disconnected', () => {
        logger.warn('[SYSTEM] MongoDB connection lost. Mongoose will attempt reconnection.');
    });

    mongoose.connection.on('reconnected', () => {
        logger.info('[SYSTEM] MongoDB connection restored.');
    });

    mongoose.connection.on('error', (error) => {
        logger.error('[MONGODB] Connection error.', error);
    });

    // useNewUrlParser and useUnifiedTopology are obsolete in current Mongoose
    // releases and can cause option errors. Current drivers enable these defaults.
    await mongoose.connect(config.database.uri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        maxPoolSize: 50,
        minPoolSize: 0
    });

    logger.info('[SYSTEM] NATERPAY MongoDB ledger connected.');
}

// -----------------------------------------------------------------------------
// PLUGINS
// -----------------------------------------------------------------------------
function getAllowedOrigins() {
    return (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

async function registerPlugins() {
    const allowedOrigins = getAllowedOrigins();

    await fastify.register(require('@fastify/cors'), {
        credentials: true,
        origin: (origin, callback) => {
            // Same-origin/server-to-server requests commonly have no Origin.
            if (!origin) return callback(null, true);

            // Do not combine Access-Control-Allow-Origin: * with credentials.
            // Configure CORS_ORIGINS as comma-separated exact frontend origins.
            if (allowedOrigins.includes(origin)) return callback(null, true);

            return callback(null, false);
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key']
    });

    await fastify.register(require('@fastify/multipart'), {
        limits: { fileSize: 25 * 1024 * 1024 },
        attachFieldsToBody: true
    });

    await fastify.register(require('@fastify/helmet'), {
        contentSecurityPolicy: false
    });

    await fastify.register(require('@fastify/static'), {
        root: require('path').join(__dirname, 'public'),
        prefix: '/'
    });

    // Flutterwave signature verification requires the exact raw JSON body.
    // Keep this plugin scoped to routes that explicitly set config.rawBody=true.
    await fastify.register(require('fastify-raw-body'), {
        field: 'rawBody',
        global: false,
        encoding: 'utf8',
        runFirst: true
    });
}

// -----------------------------------------------------------------------------
// FEATURE FLAGS
// Register this hook BEFORE routes so it applies to every route.
// -----------------------------------------------------------------------------
function registerFeatureFlagHook() {
    fastify.addHook('onRequest', async (request, reply) => {
        const path = request.url.split('?')[0];

        const disabledFeatures = [];

        if (!config.featureFlags.wallet) disabledFeatures.push('wallet');
        if (!config.featureFlags.loans) disabledFeatures.push('loan');
        if (!config.featureFlags.savings) disabledFeatures.push('savings');
        if (!config.featureFlags.escrow) disabledFeatures.push('escrow');
        if (!config.featureFlags.virtualCards) disabledFeatures.push('virtual-card');
        if (!config.featureFlags.agentBanking) disabledFeatures.push('agent-pos');
        if (!config.featureFlags.taskEarn) disabledFeatures.push('tasks');
        if (!config.featureFlags.dailyRewards) disabledFeatures.push('spin');
        if (!config.featureFlags.spinWin) disabledFeatures.push('spin');
        if (!config.featureFlags.airtimeCash) disabledFeatures.push('airtime-cash');

        for (const feature of new Set(disabledFeatures)) {
            if (
                path === `/${feature}.html` ||
                path.startsWith(`/api/${feature}/`) ||
                path === `/api/${feature}`
            ) {
                return reply.status(404).send({
                    success: false,
                    message: `The ${feature} feature is currently unavailable.`
                });
            }
        }
    });
}

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------
async function registerRoutes() {
    const auth = require('./middleware/auth');

    // IMPORTANT: The former /api/settings/company-bank endpoint has been
    // deliberately removed. It returned a hardcoded personal/company account
    // number and must never be used as a substitute for a real Flutterwave
    // virtual account.

    const authRoutes = require('./routes/auth');
    fastify.post('/api/auth/register', authRoutes.register);
    fastify.post('/api/auth/verify-otp', authRoutes.verifyOTP);
    fastify.post('/api/auth/resend-verification', authRoutes.resendVerification);
    fastify.post('/api/auth/verify-email', authRoutes.verifyEmail);
    fastify.post('/api/auth/login', authRoutes.login);
    fastify.post('/api/auth/verify-login-input', authRoutes.verifyLoginInput);
    fastify.post('/api/auth/refresh-token', authRoutes.refreshToken);
    fastify.post('/api/auth/forgot-password', authRoutes.forgotPassword);
    fastify.post('/api/auth/reset-password', authRoutes.resetPassword);
    fastify.get('/api/auth/profile', { preHandler: auth.authenticate }, authRoutes.getProfile);
    fastify.post('/api/auth/logout', { preHandler: auth.authenticate }, authRoutes.logout);
    fastify.post('/api/auth/change-password', { preHandler: auth.authenticate }, authRoutes.changePassword);
    fastify.post('/api/auth/logout-all', { preHandler: auth.authenticate }, authRoutes.logoutAllSessions);

    const userRoutes = require('./routes/user');
    fastify.get('/api/user/dashboard-data', { preHandler: auth.authenticate }, userRoutes.getDashboardData);
    fastify.post('/api/user/dashboard-preferences', { preHandler: auth.authenticate }, userRoutes.updatePreferences);
    fastify.post('/api/user/profile', { preHandler: auth.authenticate }, userRoutes.updateProfile);
    fastify.get('/api/user/referral-tree', { preHandler: auth.authenticate }, userRoutes.getReferralTree);
    fastify.post('/api/user/upgrade', { preHandler: auth.authenticate }, userRoutes.upgradeUser);

    fastify.post('/api/user/business-profile', { preHandler: auth.authenticate }, async (request, reply) => {
        try {
            const { name, email, phone, web, address, logoBase64 } = request.body || {};
            const User = require('./models/User');
            const user = await User.findById(request.user._id);

            if (!user) {
                return reply.status(404).send({ success: false, message: 'User not found.' });
            }

            if (!user.businessProfile) user.businessProfile = {};
            user.businessProfile.name = name;
            user.businessProfile.email = email;
            user.businessProfile.phone = phone;
            user.businessProfile.website = web;
            user.businessProfile.address = address;

            if (logoBase64 && logoBase64.startsWith('data:image')) {
                if (!process.env.CLOUDINARY_CLOUD_NAME ||
                    !process.env.CLOUDINARY_API_KEY ||
                    !process.env.CLOUDINARY_API_SECRET) {
                    return reply.status(503).send({
                        success: false,
                        message: 'Business logo uploads are temporarily unavailable.'
                    });
                }

                const cloudinary = require('cloudinary').v2;
                cloudinary.config({
                    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
                    api_key: process.env.CLOUDINARY_API_KEY,
                    api_secret: process.env.CLOUDINARY_API_SECRET
                });

                const uploadResult = await cloudinary.uploader.upload(logoBase64, {
                    folder: 'naterpay/logos',
                    timeout: 20000
                });

                user.businessProfile.logoUrl = uploadResult.secure_url;
                user.businessProfile.cloudinaryId = uploadResult.public_id;
            }

            await user.save();
            return reply.send({ success: true, profile: user.businessProfile });
        } catch (error) {
            logger.error('[BUSINESS PROFILE] Save failed.', error);
            return reply.status(500).send({
                success: false,
                message: 'Failed to save business profile.'
            });
        }
    });

    const walletRoutes = require('./routes/wallet');
    fastify.get('/api/wallet', { preHandler: auth.authenticate }, walletRoutes.getWallet);
    fastify.post('/api/wallet/fund', { preHandler: auth.authenticate }, walletRoutes.fundWallet);
    fastify.post('/api/wallet/fund-manual', { preHandler: auth.authenticate }, walletRoutes.fundManualWallet);
    fastify.post('/api/wallet/verify', { preHandler: auth.authenticate }, walletRoutes.verifyFunding);
    fastify.post('/api/wallet/withdraw', { preHandler: auth.authenticate }, walletRoutes.withdraw);
    fastify.post('/api/wallet/transfer', { preHandler: auth.authenticate }, walletRoutes.transfer);
    fastify.post('/api/wallet/set-pin', { preHandler: auth.authenticate }, walletRoutes.setPin);
    fastify.post('/api/wallet/verify-bank', { preHandler: auth.authenticate }, walletRoutes.resolveBankAccount);

    // Flutterwave webhook: rawBody is captured before JSON parsing. The
    // controller must verify request.rawBody against flutterwave-signature.
    fastify.post('/api/wallet/webhook/flutterwave', {
        config: { rawBody: true }
    }, walletRoutes.handleFlutterwaveWebhook);

    const vtuRoutes = require('./routes/vtu');
    fastify.post('/api/vtu/airtime', { preHandler: auth.authenticate }, vtuRoutes.buyAirtime);
    fastify.post('/api/vtu/data', { preHandler: auth.authenticate }, vtuRoutes.buyData);
    fastify.post('/api/vtu/electricity', { preHandler: auth.authenticate }, vtuRoutes.buyElectricity);
    fastify.post('/api/vtu/cable', { preHandler: auth.authenticate }, vtuRoutes.buyCable);
    fastify.post('/api/vtu/education', { preHandler: auth.authenticate }, vtuRoutes.buyEducation);
    fastify.post('/api/vtu/betting', { preHandler: auth.authenticate }, vtuRoutes.buyBetting);
    fastify.post('/api/vtu/insurance', { preHandler: auth.authenticate }, vtuRoutes.buyInsurance);
    fastify.post('/api/vtu/sms', { preHandler: auth.authenticate }, vtuRoutes.buySms);
    fastify.get('/api/vtu/rates', vtuRoutes.getRates);
    fastify.get('/api/vtu/variations', { preHandler: auth.authenticate }, vtuRoutes.getVariations);
    fastify.get('/api/vtu/international/countries', { preHandler: auth.authenticate }, vtuRoutes.getInternationalCountries);
    fastify.get('/api/vtu/international/operators', { preHandler: auth.authenticate }, vtuRoutes.getInternationalOperators);
    fastify.post('/api/vtu/foreign-airtime', { preHandler: auth.authenticate }, vtuRoutes.buyForeignAirtime);
    fastify.post('/api/vtu/foreign-data', { preHandler: auth.authenticate }, vtuRoutes.buyForeignData);

    const transactionRoutes = require('./routes/transaction');
    fastify.get('/api/transactions', { preHandler: auth.authenticate }, transactionRoutes.getTransactions);
    fastify.get('/api/transactions/:id', { preHandler: auth.authenticate }, transactionRoutes.getTransaction);

    const kycRoutes = require('./routes/kyc');
    fastify.get('/api/kyc', { preHandler: auth.authenticate }, kycRoutes.getKYC);
    fastify.post('/api/kyc/level1', { preHandler: auth.authenticate }, kycRoutes.submitLevel1);
    fastify.post('/api/kyc/level2', { preHandler: auth.authenticate }, kycRoutes.submitLevel2);
    fastify.post('/api/kyc/level3', { preHandler: auth.authenticate }, kycRoutes.submitLevel3);

    const paymentLinkRoutes = require('./routes/payment-link');
    fastify.get('/api/payment-links', { preHandler: auth.authenticate }, paymentLinkRoutes.getLinks);
    fastify.post('/api/payment-links', { preHandler: auth.authenticate }, paymentLinkRoutes.createLink);
    fastify.get('/api/payment-links/:id', paymentLinkRoutes.getLink);
    fastify.post('/api/payment-links/:id/pay', paymentLinkRoutes.payLink);
    fastify.get('/api/marketplace/all', paymentLinkRoutes.getAllMarketplaceLinks);
    fastify.get('/api/payment-links/me', { preHandler: auth.authenticate }, paymentLinkRoutes.getMyProducts);
    fastify.post('/api/payment-links/multipart', { preHandler: auth.authenticate }, paymentLinkRoutes.createProductMultipart);
    fastify.put('/api/payment-links/:id/status', { preHandler: auth.authenticate }, paymentLinkRoutes.updateProductStatus);
    fastify.delete('/api/payment-links/:id', { preHandler: auth.authenticate }, paymentLinkRoutes.deleteProductForever);

    const adsRoutes = require('./routes/ads');
    fastify.get('/api/ads', adsRoutes.getAds);
    fastify.post('/api/ads/:id/click', adsRoutes.registerClick);
    fastify.get('/api/ads/me', { preHandler: auth.authenticate }, adsRoutes.getUserAds);
    fastify.post('/api/ads', { preHandler: auth.authenticate }, adsRoutes.createAd);
    fastify.post('/api/ads/create-multipart', { preHandler: auth.authenticate }, adsRoutes.createAd);

    const tasksRoutes = require('./routes/tasks');
    fastify.post('/api/tasks/claim-ad', { preHandler: auth.authenticate }, tasksRoutes.claimAd);
    fastify.post('/api/tasks/claim-profile', { preHandler: auth.authenticate }, tasksRoutes.claimProfileReward);

    const leaderboardRoutes = require('./routes/leaderboard');
    fastify.get('/api/leaderboard', { preHandler: auth.authenticate }, leaderboardRoutes.getLeaderboard);

    const invoiceRoutes = require('./routes/invoice');
    fastify.get('/api/invoices', { preHandler: auth.authenticate }, invoiceRoutes.getInvoices);
    fastify.post('/api/invoices', { preHandler: auth.authenticate }, invoiceRoutes.createInvoice);
    fastify.delete('/api/invoices/:id', { preHandler: auth.authenticate }, invoiceRoutes.deleteInvoice);
    fastify.put('/api/invoices/:id/mark-paid', { preHandler: auth.authenticate }, invoiceRoutes.markInvoicePaid);
    fastify.get('/api/invoices/:invoiceId', invoiceRoutes.getInvoice);
    fastify.post('/api/invoices/:invoiceId/pay', invoiceRoutes.payInvoice);

    const notificationRoutes = require('./routes/notification');
    fastify.get('/api/notifications', { preHandler: auth.authenticate }, notificationRoutes.getNotifications);
    fastify.put('/api/notifications/:id/read', { preHandler: auth.authenticate }, notificationRoutes.markAsRead);
    fastify.put('/api/notifications/read-all', { preHandler: auth.authenticate }, notificationRoutes.markAllAsRead);

    const supportRoutes = require('./routes/support');
    fastify.get('/api/support/tickets', { preHandler: auth.authenticate }, supportRoutes.getTickets);
    fastify.post('/api/support/tickets', { preHandler: auth.authenticate }, supportRoutes.createTicket);
    fastify.get('/api/support/tickets/:ticketId', { preHandler: auth.authenticate }, supportRoutes.getTicket);
    fastify.post('/api/support/tickets/:ticketId/messages', { preHandler: auth.authenticate }, supportRoutes.addMessage);

    const adminRoutes = require('./routes/admin');
    fastify.get('/api/admin/users', { preHandler: auth.authenticateAdmin }, adminRoutes.getUsers);
    fastify.get('/api/admin/users/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.getUser);
    fastify.put('/api/admin/users/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.updateUser);
    fastify.get('/api/admin/transactions', { preHandler: auth.authenticateAdmin }, adminRoutes.getTransactions);
    fastify.get('/api/admin/analytics', { preHandler: auth.authenticateAdmin }, adminRoutes.getAnalytics);

    fastify.post('/api/admin/wallet/manual/approve', { preHandler: auth.authenticateAdmin }, walletRoutes.adminApproveManualFunding);
    fastify.post('/api/admin/wallet/manual/reject', { preHandler: auth.authenticateAdmin }, walletRoutes.adminRejectManualFunding);

    fastify.get('/api/admin/withdrawals/pending', { preHandler: auth.authenticateAdmin }, adminRoutes.getPendingWithdrawals);
    fastify.put('/api/admin/withdrawals/:id/:action', { preHandler: auth.authenticateAdmin }, adminRoutes.processWithdrawal);
    fastify.get('/api/admin/kyc/pending', { preHandler: auth.authenticateAdmin }, adminRoutes.getPendingKYC);
    fastify.get('/api/admin/kyc/:kycId/verify', { preHandler: auth.authenticateAdmin }, adminRoutes.verifyRealWorldKYC);
    fastify.put('/api/admin/kyc/:kycId/approve', { preHandler: auth.authenticateAdmin }, adminRoutes.approveKYC);
    fastify.put('/api/admin/kyc/:kycId/reject', { preHandler: auth.authenticateAdmin }, adminRoutes.rejectKYC);

    fastify.get('/api/admin/support/tickets', { preHandler: auth.authenticateAdmin }, adminRoutes.getSupportTickets);
    fastify.put('/api/admin/support/tickets/:id/assign', { preHandler: auth.authenticateAdmin }, adminRoutes.assignTicket);
    fastify.put('/api/admin/support/tickets/:id/resolve', { preHandler: auth.authenticateAdmin }, adminRoutes.resolveTicket);
    fastify.post('/api/admin/users/:id/balance', { preHandler: auth.authenticateAdmin }, adminRoutes.updateUserBalance);
    fastify.post('/api/admin/transactions/verify', { preHandler: auth.authenticateAdmin }, adminRoutes.verifyTransaction);
    fastify.post('/api/admin/notifications/send', { preHandler: auth.authenticateAdmin }, adminRoutes.sendPushNotification);
    fastify.put('/api/admin/products/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.updateProduct);
    fastify.delete('/api/admin/products/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.deleteProduct);
    fastify.get('/api/admin/ads', { preHandler: auth.authenticateAdmin }, adminRoutes.getPendingAds);
    fastify.put('/api/admin/ads/:id/approve', { preHandler: auth.authenticateAdmin }, adminRoutes.approveAd);
    fastify.put('/api/admin/ads/:id/reject', { preHandler: auth.authenticateAdmin }, adminRoutes.rejectAd);
    fastify.delete('/api/admin/ads/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.deleteAd);
    fastify.delete('/api/admin/support/tickets/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.deleteTicket);
    fastify.delete('/api/admin/kyc/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.deleteKycRecord);
    fastify.put('/api/admin/invoices/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.updateInvoice);
    fastify.put('/api/admin/ads/:id', { preHandler: auth.authenticateAdmin }, adminRoutes.editAd);

    const cmsRoutes = require('./routes/cms');
    fastify.get('/api/cms/homepage-data', cmsRoutes.getHomepageData);
    fastify.get('/api/slides', cmsRoutes.getSlides);
    fastify.put('/api/cms/homepage', { preHandler: auth.authenticateAdmin }, cmsRoutes.updateHomepage);
    fastify.post('/api/cms/slides', { preHandler: auth.authenticateAdmin }, cmsRoutes.addSlide);
    fastify.post('/api/cms/slides/upload', { preHandler: auth.authenticateAdmin }, cmsRoutes.addSlide);
    fastify.put('/api/cms/slides/:id', { preHandler: auth.authenticateAdmin }, cmsRoutes.updateSlide);
    fastify.delete('/api/cms/slides/:id', { preHandler: auth.authenticateAdmin }, cmsRoutes.deleteSlide);
    fastify.get('/api/cms/announcements', cmsRoutes.getAnnouncements);
    fastify.post('/api/cms/announcements', { preHandler: auth.authenticateAdmin }, cmsRoutes.addAnnouncement);
    fastify.put('/api/cms/announcements/:id', { preHandler: auth.authenticateAdmin }, cmsRoutes.updateAnnouncement);
    fastify.delete('/api/cms/announcements/:id', { preHandler: auth.authenticateAdmin }, cmsRoutes.deleteAnnouncement);
    fastify.put('/api/cms/maintenance', { preHandler: auth.authenticateAdmin }, cmsRoutes.setMaintenanceMode);
    fastify.get('/api/cms/founder', cmsRoutes.getFounderProfile);
    fastify.post('/api/cms/founder', { preHandler: auth.authenticateAdmin }, cmsRoutes.updateFounderProfile);

    const apiRoutes = require('./routes/api');
    fastify.get('/api/api/keys', { preHandler: auth.authenticate }, apiRoutes.getApiKeys);
    fastify.post('/api/api/keys', { preHandler: auth.authenticate }, apiRoutes.generateApiKey);
    fastify.delete('/api/api/keys', { preHandler: auth.authenticate }, apiRoutes.revokeApiKey);
    fastify.get('/api/api/balance', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiGetBalance);
    fastify.post('/api/api/transactions', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiCreateTransaction);

    const aiRoutes = require('./routes/ai');
    fastify.post('/api/ai/chat', { preHandler: auth.authenticate }, aiRoutes.chatWithAI);

    const statusRoutes = require('./routes/status');
    fastify.get('/api/system-status', statusRoutes.getSystemStatus);

    fastify.get('/api/health', async (request, reply) => {
        return reply.status(200).send({
            status: 'ok',
            message: 'NATERPAY API is running.',
            uptime: process.uptime()
        });
    });
}

// -----------------------------------------------------------------------------
// SOCKET.IO
// -----------------------------------------------------------------------------
function setupSocketIO(server) {
    const allowedOrigins = getAllowedOrigins();

    const io = socketIo(server, {
        cors: {
            origin: allowedOrigins.length ? allowedOrigins : false,
            methods: ['GET', 'POST'],
            credentials: true
        },
        pingTimeout: 30000,
        pingInterval: 10000
    });

    io.use(async (socket, next) => {
        try {
            const authToken = socket.handshake.auth?.token;
            const authorization = socket.handshake.headers.authorization || '';
            const bearerToken = authorization.startsWith('Bearer ')
                ? authorization.slice(7)
                : null;
            const token = authToken || bearerToken;

            if (!token || typeof token !== 'string' || token.length > 2048) {
                return next(new Error('Authentication error'));
            }

            const { verifyAccessToken } = require('./utils/auth');
            const decoded = verifyAccessToken(token);

            if (!decoded?.userId) return next(new Error('Authentication error'));

            const User = require('./models/User');
            const user = await User.findById(decoded.userId).select('_id isActive isSuspended');

            if (!user || !user.isActive || user.isSuspended) {
                return next(new Error('Authentication error'));
            }

            socket.userId = user._id.toString();
            return next();
        } catch (error) {
            logger.warn('[SOCKET] Rejected unauthenticated socket connection.');
            return next(new Error('Authentication error'));
        }
    });

    io.on('connection', (socket) => {
        socket.join(`user:${socket.userId}`);

        // Clients are intentionally not allowed to relay wallet updates,
        // notifications, CMS refreshes, or other server-originated events.
        // Emit these events from trusted backend code via fastify.io instead.
        socket.on('disconnect', () => {
            logger.info('[SOCKET] Client disconnected.', { userId: socket.userId });
        });
    });

    return io;
}

// -----------------------------------------------------------------------------
// CRON JOBS
// -----------------------------------------------------------------------------
function startCronJobs() {
    cron.schedule('*/15 * * * *', async () => {
        try {
            const reconciliationService = require('./services/reconciliation');

            if (typeof reconciliationService.reconcileTransactions === 'function') {
                await reconciliationService.reconcileTransactions();
            }
        } catch (error) {
            logger.error('[CRON] Transaction reconciliation failed.', error);
        }
    });

    cron.schedule('0 0 * * *', async () => {
        try {
            const Ad = require('./models/Ad');
            const result = await Ad.updateMany(
                { status: 'approved', expiryDate: { $lt: new Date() } },
                { $set: { status: 'expired' } }
            );

            logger.info('[CRON] Expired ad campaigns updated.', {
                modifiedCount: result.modifiedCount
            });
        } catch (error) {
            logger.error('[CRON] Ad expiration failed.', error);
        }
    });

    cron.schedule('0 0 * * *', async () => {
        try {
            const Analytics = require('./models/Analytics');
            if (typeof Analytics.recordDaily === 'function') {
                await Analytics.recordDaily();
            }
        } catch (error) {
            logger.error('[CRON] Daily analytics failed.', error);
        }
    });

    cron.schedule('0 9 * * *', async () => {
        try {
            const Invoice = require('./models/Invoice');

            if (typeof Invoice.findOverdue === 'function') {
                const overdueInvoices = await Invoice.findOverdue();

                for (const invoice of overdueInvoices) {
                    if (typeof invoice.markAsOverdue === 'function') {
                        await invoice.markAsOverdue();
                    }
                }
            }
        } catch (error) {
            logger.error('[CRON] Overdue invoice processing failed.', error);
        }
    });
}

// -----------------------------------------------------------------------------
// STARTUP / SHUTDOWN
// -----------------------------------------------------------------------------
let isShuttingDown = false;

async function start() {
    try {
        await registerPlugins();
        registerFeatureFlagHook();
        await connectDatabase();
        await registerRoutes();

        const io = setupSocketIO(fastify.server);
        fastify.io = io;

        startCronJobs();

        await fastify.listen({
            port: config.port,
            host: config.host
        });

        logger.info('[SYSTEM] NATERPAY server started.', {
            port: config.port,
            host: config.host
        });
    } catch (error) {
        logger.error('[FATAL] Server startup failed.', error);
        try {
            await fastify.close();
        } catch (_) {}
        process.exit(1);
    }
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('[SYSTEM] Graceful shutdown started.', { signal });

    try {
        if (fastify.io) {
            await new Promise((resolve) => fastify.io.close(resolve));
        }

        if (redisClient) {
            await redisClient.quit();
        }

        await fastify.close();

        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
        }

        logger.info('[SYSTEM] Graceful shutdown completed.');
        process.exit(0);
    } catch (error) {
        logger.error('[SHUTDOWN] Failed to close one or more services cleanly.', error);
        process.exit(1);
    }
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

start();
