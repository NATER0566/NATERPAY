require('dotenv').config();
const Fastify = require('fastify');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const NodeCache = require('node-cache');
const config = require('./config');

// Initialize Fastify WITH INCREASED BODY LIMIT FOR BASE64 IMAGES
const fastify = Fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: 15 * 1024 * 1024 // 15MB limit allows large CMS Slides to upload without hanging
});

// Initialize cache
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Register plugins
async function registerPlugins() {
  // CORS - Fully opened to ensure Socket.io notifications reach the dashboard
  await fastify.register(require('@fastify/cors'), {
    origin: '*',
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
  const authRoutes = require('./routes/auth');
  fastify.post('/api/auth/register', authRoutes.register);
  fastify.post('/api/auth/verify-otp', authRoutes.verifyOTP);
  fastify.post('/api/auth/login', authRoutes.login);
  fastify.post('/api/auth/verify-login-input', authRoutes.verifyLoginInput);
  fastify.post('/api/auth/refresh-token', authRoutes.refreshToken);
  fastify.post('/api/auth/forgot-password', authRoutes.forgotPassword);
  fastify.post('/api/auth/reset-password', authRoutes.resetPassword);
  
  fastify.get('/api/auth/profile', { preHandler: require('./middleware/auth').authenticate }, authRoutes.getProfile);
  fastify.post('/api/auth/logout', { preHandler: require('./middleware/auth').authenticate }, authRoutes.logout);
  
  const userRoutes = require('./routes/user');
  fastify.get('/api/user/dashboard-data', { preHandler: require('./middleware/auth').authenticate }, userRoutes.getDashboardData);
  fastify.post('/api/user/dashboard-preferences', { preHandler: require('./middleware/auth').authenticate }, userRoutes.updatePreferences);
  fastify.post('/api/user/profile', { preHandler: require('./middleware/auth').authenticate }, userRoutes.updateProfile);
  fastify.get('/api/user/referral-tree', { preHandler: require('./middleware/auth').authenticate }, userRoutes.getReferralTree);
  fastify.post('/api/user/upgrade', { preHandler: require('./middleware/auth').authenticate }, userRoutes.upgradeUser);
  
  const walletRoutes = require('./routes/wallet');
  fastify.get('/api/wallet', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.getWallet);
  fastify.post('/api/wallet/fund', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.fundWallet);
  fastify.post('/api/wallet/verify', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.verifyFunding);
  fastify.post('/api/wallet/withdraw', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.withdraw);
  fastify.post('/api/wallet/transfer', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.transfer);
  fastify.post('/api/wallet/set-pin', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.setPin);
  
  // === THIS IS THE MISSING ROUTE THAT FIXES YOUR ERROR ===
  fastify.post('/api/wallet/verify-bank', { preHandler: require('./middleware/auth').authenticate }, walletRoutes.resolveBankAccount);
  // =======================================================

  const vtuRoutes = require('./routes/vtu');
  fastify.post('/api/vtu/airtime', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyAirtime);
  fastify.post('/api/vtu/data', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyData);
  fastify.post('/api/vtu/electricity', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyElectricity);
  fastify.post('/api/vtu/cable', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyCable);
  
  // --- COMPLETE VTU ROUTE SUITE ---
  fastify.post('/api/vtu/education', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyEducation);
  fastify.post('/api/vtu/betting', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyBetting);
  fastify.post('/api/vtu/insurance', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyInsurance);
  fastify.post('/api/vtu/sms', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.sendBulkSMS);
  fastify.post('/api/vtu/pos', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.buyPOS);
  fastify.post('/api/vtu/webhook', vtuRoutes.handleVTpassWebhook);
  // ---------------------------------
  
  fastify.get('/api/vtu/rates', vtuRoutes.getRates);
  fastify.get('/api/vtu/variations', { preHandler: require('./middleware/auth').authenticate }, vtuRoutes.getVariations);
  
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
  fastify.get('/api/payment-links/:linkId', paymentLinkRoutes.getLink);
  fastify.post('/api/payment-links/:linkId/pay', paymentLinkRoutes.payLink);
  
  const invoiceRoutes = require('./routes/invoice');
  fastify.get('/api/invoices', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.getInvoices);
  fastify.post('/api/invoices', { preHandler: require('./middleware/auth').authenticate }, invoiceRoutes.createInvoice);
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
  
  fastify.post('/api/admin/users/:id/balance', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.updateUserBalance);
  fastify.post('/api/admin/transactions/verify', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.verifyTransaction);
  fastify.post('/api/admin/notifications/send', { preHandler: require('./middleware/auth').authenticateAdmin }, adminRoutes.sendPushNotification);
  
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
  
  const apiRoutes = require('./routes/api');
  fastify.get('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.getApiKeys);
  fastify.post('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.generateApiKey);
  fastify.delete('/api/api/keys', { preHandler: require('./middleware/auth').authenticate }, apiRoutes.revokeApiKey);
  fastify.get('/api/api/balance', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiGetBalance);
  fastify.post('/api/api/transactions', { preHandler: apiRoutes.authenticateApiKey }, apiRoutes.apiCreateTransaction);
  
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
      if (path.includes(`/${feature}.html`) || path.includes(`/${feature}`)) {
        return reply.status(404).send({ success: false, message: 'Feature not available' });
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
  
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.substring(7);
      if (!token) return next(new Error('Authentication error'));
      
      const { verifyAccessToken } = require('./utils/auth');
      const decoded = verifyAccessToken(token);
      if (!decoded) return next(new Error('Authentication error'));
      
      const User = require('./models/User');
      const user = await User.findById(decoded.userId);
      if (!user || !user.isActive) return next(new Error('Authentication error'));
      
      socket.user = user;
      socket.userId = user._id;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });
  
  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    socket.on('wallet:update', (data) => io.to(`user:${socket.userId}`).emit('wallet:update', data));
    socket.on('dashboard:refresh', () => io.to(`user:${socket.userId}`).emit('dashboard:refresh'));
    socket.on('cms_update', () => io.emit('cms_update'));
    socket.on('slides_refresh', () => io.emit('slides_refresh'));
    socket.on('notification', (data) => io.to(`user:${socket.userId}`).emit('notification', data));
    socket.on('disconnect', () => console.log('User disconnected:', socket.userId));
  });
  
  return io;
}

function startCronJobs() {
  const cron = require('node-cron');
  cron.schedule(config.cron.reconciliation, async () => {
    try { const { reconcileTransactions } = require('./services/reconciliation'); await reconcileTransactions(); } catch (error) {}
  });
  cron.schedule('0 0 * * *', async () => {
    try { const Analytics = require('./models/Analytics'); await Analytics.recordDaily(); } catch (error) {}
  });
  cron.schedule('0 9 * * *', async () => {
    try {
      const Invoice = require('./models/Invoice');
      const overdue = await Invoice.findOverdue();
      for (const invoice of overdue) await invoice.markAsOverdue();
    } catch (error) {}
  });
}

// Start server
async function start() {
  try {
    await registerPlugins();
    await connectDatabase();
    await registerRoutes();
    
    const io = setupSocketIO(fastify.server);
    fastify.io = io;
    
    startCronJobs();
    
    await fastify.listen({ port: config.port, host: config.host });
    console.log(`Server running on port ${config.port}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => { await fastify.close(); await mongoose.connection.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); await mongoose.connection.close(); process.exit(0); });

start();
