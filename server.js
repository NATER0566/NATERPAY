require('dotenv').config();
const Fastify = require('fastify');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const http = require('http');
const NodeCache = require('node-cache');
const config = require('./config');

// Initialize Fastify
const fastify = Fastify({
  logger: true,
  trustProxy: true
});

// Initialize cache
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Register plugins
async function registerPlugins() {
  // CORS
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
  });
  
  // Helmet
  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: false
  });
  
  // Rate limiting
  await fastify.register(require('@fastify/rate-limit'), {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    skipOnError: true
  });
  
  // Static files
  await fastify.register(require('@fastify/static'), {
    root: __dirname + '/public',
    prefix: '/'
  });
}

// Connect to MongoDB
async function connectDatabase() {
  try {
    await mongoose.connect(config.database.uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Register routes
async function registerRoutes() {
  // Auth routes
  const authRoutes = require('./routes/auth');
  fastify.post('/api/auth/register', authRoutes.register);
  fastify.post('/api/auth/verify-otp', authRoutes.verifyOTP);
  fastify.post('/api/auth/login', authRoutes.login);
  fastify.post('/api/auth/verify-login-input', authRoutes.verifyLoginInput);
  fastify.post('/api/auth/refresh-token', authRoutes.refreshToken);
  fastify.post('/api/auth/forgot-password', authRoutes.forgotPassword);
  fastify.post('/api/auth/reset-password', authRoutes.resetPassword);
  
  // Protected auth routes
  fastify.get('/api/auth/profile', { preHandler: require('./middleware/auth').authenticate }, authRoutes.getProfile);
  fastify.post('/api/auth/logout', { preHandler: require('./middleware/auth').authenticate }, authRoutes.logout);
  
  // User routes
  const userRoutes = require('./routes/user');
  fastify.get('/api/user/dashboard-data', { preHandler: require('./middleware/auth').authenticate }, userRoutes.getDashboardData);
  fastify.post('/api/user/dashboard-preferences', { preHandler: require('./middleware/auth').authenticate }, userRoutes.updatePreferences);
  fastify.post('/api/user/profile', { preHandler: require('./middleware/auth').authenticate }, userRoutes.updateProfile);
  fastify.get('/api/user/referral-tree', { preHandler: require('./middleware/auth').authenticate }, userRoutes.getReferralTree);
  
  // Wallet routes
  const walletRoutes = require('./routes/wallet');
  fastify.get('/api/wallet', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.getWallet);
  fastify.post('/api/wallet/fund', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.fundWallet);
  fastify.post('/api/wallet/verify', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.verifyFunding);
  fastify.post('/api/wallet/withdraw', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.withdraw);
  fastify.post('/api/wallet/transfer', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.transfer);
  fastify.post('/api/wallet/set-pin', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.setPin);
  
  // VTU routes
  const vtuRoutes = require('./routes/vtu');
  fastify.post('/api/vtu/airtime', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyAirtime);
  fastify.post('/api/vtu/data', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyData);
  fastify.post('/api/vtu/electricity', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyElectricity);
  fastify.post('/api/vtu/cable', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyCable);
  fastify.get('/api/vtu/rates', vtuRoutes.getRates);
  fastify.get('/api/vtu/variations', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.getVariations);
  
  // Transaction routes
  const transactionRoutes = require('./routes/transaction');
  fastify.get('/api/transactions', { preHandler: require('./middleware/auth').authenticate }, transactionRoutes.getTransactions);
  fastify.get('/api/transactions/:id', { preHandler: require('./middleware/auth').authenticate }, transactionRoutes.getTransaction);
  
  // KYC routes
  const kycRoutes = require('./routes/kyc');
  fastify.get('/api/kyc', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.getKYC);
  fastify.post('/api/kyc/level1', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.submitLevel1);
  fastify.post('/api/kyc/level2', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.submitLevel2);
  fastify.post('/api/kyc/level3', { preHandler: require('./middleware/auth').authenticate }, kycRoutes.submitLevel3);
  
  // Payment link routes
  const paymentLinkRoutes = require('./routes/payment-link');
  fastify.get('/api/payment-links', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.getLinks);
  fastify.post('/api/payment-links', { preHandler: require('./middleware/auth').authenticate }, paymentLinkRoutes.createLink);
  fastify.get('/api/payment-links/:linkId', paymentLinkRoutes.getLink);
  fastify.post('/api/payment-links/:linkId/pay', paymentLinkRoutes.payLink);
  
  // Invoice routes
  const invoiceRoutes = require('./routes/invoice');
  fastify.get('/api/invoices', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.getInvoices);
  fastify.post('/api/invoices', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.createInvoice);
  fastify.get('/api/invoices/:invoiceId', invoiceRoutes.getInvoice);
  fastify.post('/api/invoices/:invoiceId/pay', invoiceRoutes.payInvoice);
  
  // Notification routes
  const notificationRoutes = require('./routes/notification');
  fastify.get('/api/notifications', { preHandler: require('./middleware/auth').authenticate }, notificationRoutes.getNotifications);
  fastify.put('/api/notifications/:id/read', { preHandler: require('./middleware/auth').authenticate }, notificationRoutes.markAsRead);
  fastify.put('/api/notifications/read-all', { preHandler: require('./middleware/auth').authenticate }, notificationRoutes.markAllAsRead);
  
  // Support routes
  const supportRoutes = require('./routes/support');
  fastify.get('/api/support/tickets', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.getTickets);
  fastify.post('/api/support/tickets', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.createTicket);
  fastify.get('/api/support/tickets/:ticketId', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.getTicket);
  fastify.post('/api/support/tickets/:ticketId/messages', { preHandler: require('./middleware/auth').authenticate }, supportRoutes.addMessage);
  
  // Admin routes
  const adminRoutes = require('./routes/admin');
  fastify.get('/api/admin/users', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getUsers);
  fastify.get('/api/admin/users/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getUser);
  fastify.put('/api/admin/users/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.updateUser);
  fastify.get('/api/admin/transactions', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getTransactions);
  fastify.get('/api/admin/analytics', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getAnalytics);
  fastify.get('/api/admin/kyc/pending', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getPendingKYC);
  fastify.put('/api/admin/kyc/:id/approve', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.approveKYC);
  fastify.put('/api/admin/kyc/:id/reject', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.rejectKYC);
  fastify.get('/api/admin/support/tickets', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.getSupportTickets);
  fastify.put('/api/admin/support/tickets/:id/assign', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.assignTicket);
  fastify.put('/api/admin/support/tickets/:id/resolve', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.resolveTicket);
  
  // CMS routes
  const cmsRoutes = require('./routes/cms');
  fastify.get('/api/cms/homepage-data', cmsRoutes.getHomepageData);
  fastify.get('/api/slides', cmsRoutes.getSlides);
  fastify.put('/api/cms/homepage', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateHomepage);
  fastify.post('/api/cms/slides', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.addSlide);
  fastify.put('/api/cms/slides/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateSlide);
  fastify.delete('/api/cms/slides/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.deleteSlide);
  fastify.get('/api/cms/announcements', cmsRoutes.getAnnouncements);
  fastify.post('/api/cms/announcements', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.addAnnouncement);
  fastify.put('/api/cms/announcements/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.updateAnnouncement);
  fastify.delete('/api/cms/announcements/:id', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.deleteAnnouncement);
  fastify.put('/api/cms/maintenance', { preHandler: require('./middleware/auth').authenticateAdmin }, cmsRoutes.setMaintenanceMode);
  
  // Developer API routes
  const apiRoutes = require('./routes/api');
  fastify.get('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.getApiKeys);
  fastify.post('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.generateApiKey);
  fastify.delete('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.revokeApiKey);
  fastify.get('/api/api/balance', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiGetBalance);
  fastify.post('/api/api/transactions', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiCreateTransaction);
  
  // Feature flag middleware
  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url;
    
    // Check feature flags for disabled features
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
      if (path.includes(`/${feature}.html`) || path.includes(`/${feature}`)) {
        return reply.status(404).send({
          success: false,
          message: 'Feature not available'
        });
      }
    }
  });
}

// Setup Socket.io
function setupSocketIO(server) {
  const io = socketIo(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });
  
  // Authentication middleware for Socket.io
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.substring(7);
      if (!token) {
        return next(new Error('Authentication error'));
      }
      
      const { verifyAccessToken } = require('./utils/auth');
      const decoded = verifyAccessToken(token);
      
      if (!decoded) {
        return next(new Error('Authentication error'));
      }
      
      const User = require('./models/User');
      const user = await User.findById(decoded.userId);
      
      if (!user || !user.isActive) {
        return next(new Error('Authentication error'));
      }
      
      socket.user = user;
      socket.userId = user._id;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });
  
  io.on('connection', (socket) => {
    console.log('User connected:', socket.userId);
    
    // Join user's personal room
    socket.join(`user:${socket.userId}`);
    
    // Handle wallet updates
    socket.on('wallet:update', (data) => {
      io.to(`user:${socket.userId}`).emit('wallet:update', data);
    });
    
    // Handle dashboard refresh
    socket.on('dashboard:refresh', () => {
      io.to(`user:${socket.userId}`).emit('dashboard:refresh');
    });
    
    // Handle CMS updates
    socket.on('cms_update', () => {
      io.emit('cms_update');
    });
    
    // Handle slides refresh
    socket.on('slides_refresh', () => {
      io.emit('slides_refresh');
    });
    
    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.userId);
    });
  });
  
  return io;
}

// Start cron jobs
function startCronJobs() {
  const cron = require('node-cron');
  
  // Reconciliation job
  cron.schedule(config.cron.reconciliation, async () => {
    console.log('Running reconciliation job...');
    try {
      const { reconcileTransactions } = require('./services/reconciliation');
      await reconcileTransactions();
    } catch (error) {
      console.error('Reconciliation job error:', error);
    }
  });
  
  // Analytics recording job
  cron.schedule('0 0 * * *', async () => {
    console.log('Recording daily analytics...');
    try {
      const Analytics = require('./models/Analytics');
      await Analytics.recordDaily();
    } catch (error) {
      console.error('Analytics recording error:', error);
    }
  });
  
  // Overdue invoice check
  cron.schedule('0 9 * * *', async () => {
    console.log('Checking overdue invoices...');
    try {
      const Invoice = require('./models/Invoice');
      const overdue = await Invoice.findOverdue();
      for (const invoice of overdue) {
        await invoice.markAsOverdue();
        // Send reminder notification
      }
    } catch (error) {
      console.error('Overdue invoice check error:', error);
    }
  });
}

// Start server
async function start() {
  try {
    await registerPlugins();
    await connectDatabase();
    await registerRoutes();
    
    // Pass Fastify's native server to Socket.io
    const io = setupSocketIO(fastify.server);
    
    // Make io accessible globally
    fastify.io = io;
    
    // Start cron jobs
    startCronJobs();
    
    // Start listening on the port just ONCE
    await fastify.listen({ port: config.port, host: config.host });
    console.log(`Server running on port ${config.port}`);
    
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await fastify.close();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await fastify.close();
  await mongoose.connection.close();
  process.exit(0);
});

start();
