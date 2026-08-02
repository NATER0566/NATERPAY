require('dotenv').config();
const Fastify = require('fastify');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const cron = require('node-cron');
const config = require('./config');

// [1] STRUCTURED LOGGING ENGINE
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

// [2] REDIS ENGINE (LOUD MODE & TLS FIXED)
let Redis;
let redisClient = null;
try { 
    Redis = require('ioredis'); 
    if (process.env.REDIS_URL) {
        // FIXED: Added TLS configuration so Upstash accepts the connection perfectly
        redisClient = new Redis(process.env.REDIS_URL, {
            tls: { rejectUnauthorized: false },
            maxRetriesPerRequest: 3
        });
        redisClient.on('connect', () => logger.info('[SYSTEM] Redis Distributed Cache connected successfully.'));
        redisClient.on('error', (err) => logger.error('[FATAL] Redis Connection Error', err));
    }
} catch(e) {
    logger.warn('[SYSTEM] Redis not installed. Rate limiting will fall back to local memory.');
}

// ============================================================================
// CORE SYSTEM INITIALIZATION
// ============================================================================
const fastify = Fastify({
    logger: false, // We use our custom Pino logger
    trustProxy: true, // Crucial for accurate IP tracking behind Cloudflare/Nginx
    bodyLimit: 15 * 1024 * 1024 
});

// [3] GLOBAL ERROR CATCHER (FIXED)
fastify.setErrorHandler(function (error, request, reply) {
    logger.error(`[CRITICAL] Path: ${request.url} | Error: ${error.message}`);
    
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongooseError') {
        return reply.status(503).send({
            success: false,
            message: 'Database sync in progress. Please wait a few seconds and try again.'
        });
    }

    // THE EXACT FIX: The hardcoded 429 black-screen response was completely removed from here.
    
    reply.status(500).send({ 
        success: false, 
        message: 'A temporary network delay occurred. Please refresh the page.' 
    });
});

// ============================================================================
// DATABASE CONNECTION (MongoDB)
// ============================================================================
async function connectDatabase() {
    try {
        mongoose.connection.on('disconnected', () => {
            logger.warn('[SYSTEM] MongoDB disconnected! Attempting to auto-reconnect...');
        });
        mongoose.connection.on('reconnected', () => {
            logger.info('[SYSTEM] MongoDB reconnected successfully.');
        });

        await mongoose.connect(config.database.uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 30000, // FIXED: Increased from 5000 to prevent Atlas Free Tier crashes
            socketTimeoutMS: 45000,          // FIXED: Keeps sockets alive longer
            maxPoolSize: 100                 // FIXED: Allows more concurrent users
        });
        logger.info('[SYSTEM] Naterpay Database Ledger connected successfully.');
    } catch (error) {
        logger.error('[FATAL ERROR] MongoDB connection failed:', error);
        process.exit(1); 
    }
}

// ============================================================================
// PLUGIN REGISTRATION (Security, CORS, Static Files)
// ============================================================================
async function registerPlugins() {
    await fastify.register(require('@fastify/cors'), {
        origin: '*', // In strict production, restrict this to your exact frontend domain
        credentials: true
    });

    await fastify.register(require('@fastify/multipart'), {
        limits: { fileSize: 25 * 1024 * 1024 } 
    });
  
    await fastify.register(require('@fastify/helmet'), {
        contentSecurityPolicy: false // Disabled to allow external images (Cloudinary) and scripts
    });
  
    // THE EXACT FIX: The @fastify/rate-limit plugin was entirely removed from here.
    // It was causing the global 429 black screens. Your route files (like wallet.js) 
    // already have their own safe limiters, so this global one was redundant and dangerous.
  
    await fastify.register(require('@fastify/static'), {
        root: __dirname + '/public',
        prefix: '/'
    });
}

// ============================================================================
// ENTERPRISE ROUTE REGISTRATION API MAP
// ============================================================================
async function registerRoutes() {

    // [NEW] DYNAMIC BANK DETAILS ROUTE
    fastify.get('/api/settings/company-bank', async (request, reply) => {
        reply.send({
            success: true,
            bankName: process.env.COMPANY_BANK_NAME || "MONIEPOINT MFB",
            accountNumber: process.env.COMPANY_ACCOUNT_NO || "8160979620",
            accountName: process.env.COMPANY_ACCOUNT_NAME || "NATER GRACE CODE"
        });
    });

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
    fastify.get('/api/auth/profile', { preHandler: require('./middleware/auth').authenticate }, authRoutes.getProfile);
    fastify.post('/api/auth/logout', { preHandler: require('./middleware/auth').authenticate }, authRoutes.logout);
    fastify.post('/api/auth/change-password', { preHandler: require('./middleware/auth').authenticate }, authRoutes.changePassword);
    fastify.post('/api/auth/logout-all', { preHandler: require('./middleware/auth').authenticate }, authRoutes.logoutAllSessions);
    
    const userRoutes = require('./routes/user');
    fastify.get('/api/user/dashboard-data', { preHandler: require('./middleware/auth').authenticate }, userRoutes.getDashboardData);
    fastify.post('/api/user/dashboard-preferences', { preHandler: require('./middleware/auth').authenticate }, userRoutes.updatePreferences);
    fastify.post('/api/user/profile', { preHandler: require('./middleware/auth').authenticate }, userRoutes.updateProfile);
    fastify.get('/api/user/referral-tree', { preHandler: require('./middleware/auth').authenticate }, userRoutes.getReferralTree);
    fastify.post('/api/user/upgrade', { preHandler: require('./middleware/auth').authenticate }, userRoutes.upgradeUser);

    fastify.post('/api/user/business-profile', { preHandler: require('./middleware/auth').authenticate }, async (request, reply) => {
        try {
            const { name, email, phone, web, address, logoBase64 } = request.body;
            const User = require('./models/User');
            const user = await User.findById(request.user._id);
            
            if (!user.businessProfile) user.businessProfile = {};
            user.businessProfile.name = name;
            user.businessProfile.email = email;
            user.businessProfile.phone = phone;
            user.businessProfile.website = web;
            user.businessProfile.address = address;

            if (logoBase64 && logoBase64.startsWith('data:image')) {
                const cloudinary = require('cloudinary').v2;
                if (process.env.CLOUDINARY_CLOUD_NAME) {
                    cloudinary.config({
                        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
                        api_key: process.env.CLOUDINARY_API_KEY,
                        api_secret: process.env.CLOUDINARY_API_SECRET
                    });
                    const uploadRes = await cloudinary.uploader.upload(logoBase64, { folder: 'naterpay/logos', timeout: 20000 });
                    user.businessProfile.logoUrl = uploadRes.secure_url;
                    user.businessProfile.cloudinaryId = uploadRes.public_id;
                } else {
                    user.businessProfile.logoUrl = logoBase64;
                }
            }
            
            await user.save();
            reply.send({ success: true, profile: user.businessProfile });
        } catch (err) {
            logger.error('Business Profile Save Error:', err);
            reply.status(500).send({ success: false, message: 'Failed to save business profile.' });
        }
    });
  
    const walletRoutes = require('./routes/wallet');
    fastify.get('/api/wallet', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.getWallet);
    fastify.post('/api/wallet/fund', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.fundWallet);
    fastify.post('/api/wallet/fund-manual', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.fundManualWallet);
    fastify.post('/api/wallet/verify', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.verifyFunding);
    fastify.post('/api/wallet/withdraw', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.withdraw);
    fastify.post('/api/wallet/transfer', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.transfer);
    fastify.post('/api/wallet/set-pin', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.setPin);
    fastify.post('/api/wallet/verify-bank', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.resolveBankAccount);

    // === WEBHOOKS ===
    fastify.post('/api/webhooks/paystack', walletRoutes.handlePaystackWebhook);
    
    const vtuRoutes = require('./routes/vtu');
    fastify.post('/api/vtu/airtime', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyAirtime);
    fastify.post('/api/vtu/data', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyData);
    fastify.post('/api/vtu/electricity', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyElectricity);
    fastify.post('/api/vtu/cable', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyCable);
    fastify.post('/api/vtu/education', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyEducation);
    fastify.post('/api/vtu/betting', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyBetting);
    fastify.post('/api/vtu/insurance', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyInsurance);
    fastify.post('/api/vtu/sms', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buySms);
    fastify.get('/api/vtu/rates', vtuRoutes.getRates);
    fastify.get('/api/vtu/variations', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.getVariations);
    
    // [FIX] CONNECTIONS FOR GLOBAL AIRTIME & DATA
    fastify.get('/api/vtu/international/countries', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.getInternationalCountries);
    fastify.get('/api/vtu/international/operators', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.getInternationalOperators);
    fastify.post('/api/vtu/foreign-airtime', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyForeignAirtime);
    fastify.post('/api/vtu/foreign-data', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyForeignData);
    
    const transactionRoutes = require('./routes/transaction');
    fastify.get('/api/transactions', { preHandler: require('./middleware/auth').authenticate }, transactionRoutes.getTransactions);
    fastify.get('/api/transactions/:id', { preHandler: require('./middleware/auth').authenticate }, transactionRoutes.getTransaction);
    
    const kycRoutes = require('./routes/kyc');
    fastify.get('/api/kyc', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.getKYC);
    fastify.post('/api/kyc/level1', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.submitLevel1);
    fastify.post('/api/kyc/level2', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.submitLevel2);
    fastify.post('/api/kyc/level3', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.submitLevel3);
    
    const paymentLinkRoutes = require('./routes/payment-link');
    fastify.get('/api/payment-links', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.getLinks);
    fastify.post('/api/payment-links', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.createLink); 
    fastify.get('/api/payment-links/:id', paymentLinkRoutes.getLink);
    fastify.post('/api/payment-links/:id/pay', paymentLinkRoutes.payLink);
    fastify.get('/api/marketplace/all', paymentLinkRoutes.getAllMarketplaceLinks);
    fastify.get('/api/payment-links/me', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.getMyProducts);
    fastify.post('/api/payment-links/multipart', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.createProductMultipart);
    fastify.put('/api/payment-links/:id/status', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.updateProductStatus);
    fastify.delete('/api/payment-links/:id', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.deleteProductForever);

    const adsRoutes = require('./routes/ads');
    fastify.get('/api/ads', adsRoutes.getAds);
    fastify.post('/api/ads/:id/click', adsRoutes.registerClick);
    fastify.get('/api/ads/me', { preHandler: require('./middleware/auth').authenticate }, adsRoutes.getUserAds);
    fastify.post('/api/ads', { preHandler: require('./middleware/auth').authenticate }, adsRoutes.createAd);
    fastify.post('/api/ads/create-multipart', { preHandler: require('./middleware/auth').authenticate }, adsRoutes.createAd);
    
    const tasksRoutes = require('./routes/tasks');
    fastify.post('/api/tasks/claim-ad', { preHandler: require('./middleware/auth').authenticate }, tasksRoutes.claimAd);
    fastify.post('/api/tasks/claim-profile', { preHandler: require('./middleware/auth').authenticate }, tasksRoutes.claimProfileReward);
    
    const leaderboardRoutes = require('./routes/leaderboard');
    fastify.get('/api/leaderboard', { preHandler: require('./middleware/auth').authenticate }, leaderboardRoutes.getLeaderboard);
    
    const invoiceRoutes = require('./routes/invoice');
    fastify.get('/api/invoices', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.getInvoices);
    fastify.post('/api/invoices', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.createInvoice);
    fastify.delete('/api/invoices/:id', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.deleteInvoice);
    fastify.put('/api/invoices/:id/mark-paid', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.markInvoicePaid);
    fastify.get('/api/invoices/:invoiceId', invoiceRoutes.getInvoice);
    fastify.post('/api/invoices/:invoiceId/pay', invoiceRoutes.payInvoice);
    
    const notificationRoutes = require('./routes/notification');
    fastify.get('/api/notifications', { preHandler: require('./middleware/auth').authenticate }, notificationRoutes.getNotifications);
    fastify.put('/api/notifications/:id/read', { preHandler: require('./middleware/auth').authenticate }, notificationRoutes.markAsRead);
    fastify.put('/api/notifications/read-all', { preHandler: require('./middleware/auth').authenticate }, notificationRoutes.markAllAsRead);
    
    const supportRoutes = require('./routes/support');
    fastify.get('/api/support/tickets', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.getTickets);
    fastify.post('/api/support/tickets', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.createTicket);
    fastify.get('/api/support/tickets/:ticketId', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.getTicket);
    fastify.post('/api/support/tickets/:ticketId/messages', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.addMessage);
    
    // === ADMIN PANEL ROUTES ===
    const adminRoutes = require('./routes/admin');
    fastify.get('/api/admin/users', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getUsers);
    fastify.get('/api/admin/users/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getUser);
    fastify.put('/api/admin/users/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.updateUser);
    fastify.get('/api/admin/transactions', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getTransactions);
    fastify.get('/api/admin/analytics', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getAnalytics);
    
    fastify.post('/api/admin/wallet/manual/approve', { preHandler: require('./middleware/auth').authenticateAdmin }, walletRoutes.adminApproveManualFunding);
    fastify.post('/api/admin/wallet/manual/reject', { preHandler: require('./middleware/auth').authenticateAdmin }, walletRoutes.adminRejectManualFunding);

    fastify.get('/api/admin/withdrawals/pending', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getPendingWithdrawals);
    fastify.put('/api/admin/withdrawals/:id/:action', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.processWithdrawal);

    fastify.get('/api/admin/kyc/pending', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getPendingKYC);
    fastify.get('/api/admin/kyc/:kycId/verify', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.verifyRealWorldKYC);
    fastify.put('/api/admin/kyc/:kycId/approve', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.approveKYC);
    fastify.put('/api/admin/kyc/:kycId/reject', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.rejectKYC);

    fastify.get('/api/admin/support/tickets', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getSupportTickets);
    fastify.put('/api/admin/support/tickets/:id/assign', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.assignTicket);
    fastify.put('/api/admin/support/tickets/:id/resolve', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.resolveTicket);
    
    fastify.post('/api/admin/users/:id/balance', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.updateUserBalance);
    fastify.post('/api/admin/transactions/verify', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.verifyTransaction);
    fastify.post('/api/admin/notifications/send', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.sendPushNotification);
    
    fastify.put('/api/admin/products/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.updateProduct);
    fastify.delete('/api/admin/products/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.deleteProduct);

    fastify.get('/api/admin/ads', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getPendingAds);
    fastify.put('/api/admin/ads/:id/approve', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.approveAd);
    fastify.put('/api/admin/ads/:id/reject', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.rejectAd);
    fastify.delete('/api/admin/ads/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.deleteAd);

    // [FIX] MISSING DELETE & EDIT ROUTES FOR ADMIN PANEL
    fastify.delete('/api/admin/support/tickets/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.deleteTicket);
    fastify.delete('/api/admin/kyc/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.deleteKycRecord);
    fastify.put('/api/admin/invoices/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.updateInvoice);
    fastify.put('/api/admin/ads/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.editAd);
    
    // === CMS / HOMEPAGE / SLIDES / FOUNDER ROUTES ===
    const cmsRoutes = require('./routes/cms');
    fastify.get('/api/cms/homepage-data', cmsRoutes.getHomepageData);
    fastify.get('/api/slides', cmsRoutes.getSlides);
    fastify.put('/api/cms/homepage', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateHomepage);
    fastify.post('/api/cms/slides', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.addSlide);
    fastify.post('/api/cms/slides/upload', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.addSlide);
    fastify.put('/api/cms/slides/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateSlide);
    fastify.delete('/api/cms/slides/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.deleteSlide);
    fastify.get('/api/cms/announcements', cmsRoutes.getAnnouncements);
    fastify.post('/api/cms/announcements', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.addAnnouncement);
    fastify.put('/api/cms/announcements/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateAnnouncement);
    fastify.delete('/api/cms/announcements/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.deleteAnnouncement);
    fastify.put('/api/cms/maintenance', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.setMaintenanceMode);
    fastify.get('/api/cms/founder', cmsRoutes.getFounderProfile);
    fastify.post('/api/cms/founder', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateFounderProfile);
    
    const apiRoutes = require('./routes/api');
    fastify.get('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.getApiKeys);
    fastify.post('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.generateApiKey);
    fastify.delete('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.revokeApiKey);
    fastify.get('/api/api/balance', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiGetBalance);
    fastify.post('/api/api/transactions', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiCreateTransaction);

    // === NATERPAY AI SYSTEM ===
    const aiRoutes = require('./routes/ai');
    fastify.post('/api/ai/chat', { preHandler: require('./middleware/auth').authenticate }, aiRoutes.chatWithAI);

    // === KORAPAY TEST ROUTE ===
    fastify.register(require('./routes/koraTest'), { prefix: '/api/kora' });

    const statusRoutes = require('./routes/status');
    fastify.get('/api/system-status', statusRoutes.getSystemStatus);

    fastify.get('/api/health', async (request, reply) => {
        return reply.status(200).send({ 
            status: 'ok', 
            message: 'Engine running perfectly.', 
            uptime: process.uptime() 
        });
    });
    
    // [4] FEATURE FLAG MIDDLEWARE
    fastify.addHook('onRequest', async (request, reply) => {
        const path = request.url;
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
        
        for (const feature of disabledFeatures) {
            if (path === `/${feature}.html` || path.startsWith(`/api/${feature}`)) {
                return reply.status(404).send({ success: false, message: `The ${feature} feature is currently disabled for maintenance.` });
            }
        }
    });
}

// ============================================================================
// WEBSOCKET ENGINE
// ============================================================================
function setupSocketIO(server) {
    const io = socketIo(server, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
        pingTimeout: 30000,
        pingInterval: 10000
    });
    
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.substring(7);
            if (!token || token.length > 2048) return next(new Error('Authentication error'));
            
            const { verifyAccessToken } = require('./utils/auth');
            const decoded = verifyAccessToken(token);
            if (!decoded) return next(new Error('Authentication error'));
            
            const User = require('./models/User');
            const user = await User.findById(decoded.userId);
            if (!user || !user.isActive || user.isSuspended) return next(new Error('Authentication error'));
            
            socket.user = user;
            socket.userId = user._id;
            next();
        } catch (error) {
            next(new Error('Authentication error'));
        }
    });
    
    io.on('connection', (socket) => {
        socket.join(`user:${socket.userId}`);
        
        let eventCount = 0;
        const resetInterval = setInterval(() => { eventCount = 0; }, 10000); 
        
        socket.use((packet, next) => {
            if (++eventCount > 500) return next(new Error('Rate limit exceeded'));
            next();
        });

        socket.on('wallet:update', (data) => io.to(`user:${socket.userId}`).emit('wallet:update', data));
        socket.on('dashboard:refresh', () => io.to(`user:${socket.userId}`).emit('dashboard:refresh'));
        socket.on('cms_update', () => io.emit('cms_update'));
        socket.on('slides_refresh', () => io.emit('slides_refresh'));
        socket.on('notification', (data) => io.to(`user:${socket.userId}`).emit('notification', data));
        
        socket.on('disconnect', () => {
            clearInterval(resetInterval);
        });
    });
    
    return io;
}

// ============================================================================
// AUTOMATED CRON JOBS
// ============================================================================
function startCronJobs() {
    cron.schedule('*/15 * * * *', async () => {
        try {
            const reconciliationService = require('./services/reconciliation');
            if (reconciliationService && typeof reconciliationService.reconcileTransactions === 'function') {
                await reconciliationService.reconcileTransactions();
            }
        } catch (error) {
            logger.error('[CRON ERROR] Transaction Reconciliation Failed:', error);
        }
    });

    cron.schedule('0 0 * * *', async () => {
        try {
            const Ad = require('./models/Ad');
            const expiredResult = await Ad.updateMany(
                { status: 'approved', expiryDate: { $lt: new Date() } },
                { status: 'expired' }
            );
            logger.info(`[SYSTEM CRON] Wiped and expired ${expiredResult.modifiedCount} old ad campaigns.`);
        } catch (error) {
            logger.error('[CRON ERROR] Ad campaign automatic expiration failed:', error);
        }
    });

    cron.schedule('0 0 * * *', async () => {
        try { const Analytics = require('./models/Analytics'); if(Analytics.recordDaily) await Analytics.recordDaily(); } catch (error) {}
    });

    cron.schedule('0 9 * * *', async () => {
        try {
            const Invoice = require('./models/Invoice');
            if(Invoice.findOverdue) {
                const overdue = await Invoice.findOverdue();
                for (const invoice of overdue) if(invoice.markAsOverdue) await invoice.markAsOverdue();
            }
        } catch (error) {}
    });
}

// ============================================================================
// BOOT ENGINE & GRACEFUL SHUTDOWN
// ============================================================================
async function start() {
    try {
        await registerPlugins();
        await connectDatabase();
        await registerRoutes();
        
        const io = setupSocketIO(fastify.server);
        fastify.io = io;
        
        startCronJobs();
        
        await fastify.listen({ port: config.port, host: config.host });
        logger.info(`[SYSTEM] Core Engine Successfully Bound to Port ${config.port}`);
    } catch (error) {
        console.error('============== CRITICAL BOOT CRASH ==============');
        console.error(error);
        console.error('=================================================');
        process.exit(1);
    }
}

async function gracefulShutdown() {
    logger.info('[SYSTEM] Received shutdown signal. Closing HTTP server and database gracefully...');
    try {
        if (redisClient) await redisClient.quit();
        await fastify.close();
        await mongoose.connection.close();
        logger.info('[SYSTEM] Shutdown complete. Goodbye.');
        process.exit(0);
    } catch (err) {
        logger.error('[FATAL] Error during graceful shutdown:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start();
