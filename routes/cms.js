const cmsController = require('../controllers/cmsController');

async function cmsRoutes(fastify, options) {
  // === PUBLIC ROUTES ===
  fastify.get('/homepage-data', cmsController.getHomepageData);
  fastify.get('/slides', cmsController.getSlides);
  fastify.get('/announcements', cmsController.getAnnouncements);
  
  // New public route to fetch founder details
  fastify.get('/founder', cmsController.getFounderProfile);

  // === PROTECTED ADMIN ROUTES ===
  fastify.post('/homepage-data', { preValidation: [fastify.authenticate] }, cmsController.updateHomepage);
  fastify.post('/slides', { preValidation: [fastify.authenticate] }, cmsController.addSlide);
  fastify.put('/slides/:id', { preValidation: [fastify.authenticate] }, cmsController.updateSlide);
  fastify.delete('/slides/:id', { preValidation: [fastify.authenticate] }, cmsController.deleteSlide);
  
  fastify.post('/announcements', { preValidation: [fastify.authenticate] }, cmsController.addAnnouncement);
  fastify.put('/announcements/:id', { preValidation: [fastify.authenticate] }, cmsController.updateAnnouncement);
  fastify.delete('/announcements/:id', { preValidation: [fastify.authenticate] }, cmsController.deleteAnnouncement);
  
  fastify.post('/maintenance', { preValidation: [fastify.authenticate] }, cmsController.setMaintenanceMode);

  // New protected route to update founder details from the Admin Panel
  fastify.post('/founder', { preValidation: [fastify.authenticate] }, cmsController.updateFounderProfile);
}

module.exports = cmsRoutes;
