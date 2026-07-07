const CMS = require('../models/CMS');

/**
 * Get homepage data (public)
 */
async function getHomepageData(request, reply) {
  try {
    const data = await CMS.getHomepageData();
    
    reply.send({
      success: true,
      data: data?.homepage || {
        siteName: 'NATER-PAY',
        logoUrl: null,
        tagline: 'Enterprise Fintech Services Platform',
        rates: {
          mtn: 215,
          airtel: 190,
          glo: 220,
          nineMobile: 180
        }
      }
    });
  } catch (error) {
    console.error('Get homepage data error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch homepage data'
    });
  }
}

/**
 * Get slides (public)
 */
async function getSlides(request, reply) {
  try {
    const { page } = request.query;
    
    const slides = await CMS.getActiveSlides();
    
    reply.send({
      success: true,
      data: slides
    });
  } catch (error) {
    console.error('Get slides error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch slides'
    });
  }
}

/**
 * Update homepage (admin)
 */
async function updateHomepage(request, reply) {
  try {
    const { siteName, logoUrl, tagline, rates } = request.body;
    
    await CMS.updateHomepage({
      siteName,
      logoUrl,
      tagline,
      rates
    });
    
    // Emit socket event for real-time update
    if (request.server.io) {
      request.server.io.emit('cms_update');
    }
    
    reply.send({
      success: true,
      message: 'Homepage updated successfully'
    });
  } catch (error) {
    console.error('Update homepage error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update homepage'
    });
  }
}

/**
 * Add slide (admin)
 */
async function addSlide(request, reply) {
  try {
    const { title, caption, mediaType, mediaUrl, ctaText, ctaLink, order } = request.body;
    
    if (!title || !caption || !mediaUrl) {
      return reply.status(400).send({
        success: false,
        message: 'Title, caption, and media URL are required'
      });
    }
    
    await CMS.addSlide({
      title,
      caption,
      mediaType: mediaType || 'image',
      mediaUrl,
      ctaText,
      ctaLink,
      order: order || 0
    });
    
    // Emit socket event for real-time update
    if (request.server.io) {
      request.server.io.emit('slides_refresh');
    }
    
    reply.send({
      success: true,
      message: 'Slide added successfully'
    });
  } catch (error) {
    console.error('Add slide error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to add slide'
    });
  }
}

/**
 * Update slide (admin)
 */
async function updateSlide(request, reply) {
  try {
    const { id } = request.params;
    const { title, caption, mediaType, mediaUrl, ctaText, ctaLink, order, isActive } = request.body;
    
    await CMS.updateSlide(id, {
      title,
      caption,
      mediaType,
      mediaUrl,
      ctaText,
      ctaLink,
      order,
      isActive
    });
    
    // Emit socket event for real-time update
    if (request.server.io) {
      request.server.io.emit('slides_refresh');
    }
    
    reply.send({
      success: true,
      message: 'Slide updated successfully'
    });
  } catch (error) {
    console.error('Update slide error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update slide'
    });
  }
}

/**
 * Delete slide (admin)
 */
async function deleteSlide(request, reply) {
  try {
    const { id } = request.params;
    
    await CMS.deleteSlide(id);
    
    // Emit socket event for real-time update
    if (request.server.io) {
      request.server.io.emit('slides_refresh');
    }
    
    reply.send({
      success: true,
      message: 'Slide deleted successfully'
    });
  } catch (error) {
    console.error('Delete slide error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to delete slide'
    });
  }
}

/**
 * Get announcements (public)
 */
async function getAnnouncements(request, reply) {
  try {
    const { targetAudience } = request.query;
    
    const announcements = await CMS.getActiveAnnouncements(targetAudience || 'all');
    
    reply.send({
      success: true,
      data: announcements
    });
  } catch (error) {
    console.error('Get announcements error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch announcements'
    });
  }
}

/**
 * Add announcement (admin)
 */
async function addAnnouncement(request, reply) {
  try {
    const { title, message, type, isActive, startDate, endDate, targetAudience } = request.body;
    
    if (!title || !message) {
      return reply.status(400).send({
        success: false,
        message: 'Title and message are required'
      });
    }
    
    await CMS.addAnnouncement({
      title,
      message,
      type: type || 'info',
      isActive: isActive !== false,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      targetAudience: targetAudience || 'all'
    });
    
    reply.send({
      success: true,
      message: 'Announcement added successfully'
    });
  } catch (error) {
    console.error('Add announcement error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to add announcement'
    });
  }
}

/**
 * Update announcement (admin)
 */
async function updateAnnouncement(request, reply) {
  try {
    const { id } = request.params;
    const { title, message, type, isActive, startDate, endDate, targetAudience } = request.body;
    
    await CMS.updateAnnouncement(id, {
      title,
      message,
      type,
      isActive,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      targetAudience
    });
    
    reply.send({
      success: true,
      message: 'Announcement updated successfully'
    });
  } catch (error) {
    console.error('Update announcement error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update announcement'
    });
  }
}

/**
 * Delete announcement (admin)
 */
async function deleteAnnouncement(request, reply) {
  try {
    const { id } = request.params;
    
    await CMS.deleteAnnouncement(id);
    
    reply.send({
      success: true,
      message: 'Announcement deleted successfully'
    });
  } catch (error) {
    console.error('Delete announcement error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to delete announcement'
    });
  }
}

/**
 * Set maintenance mode (admin)
 */
async function setMaintenanceMode(request, reply) {
  try {
    const { enabled, message, scheduledStart, scheduledEnd } = request.body;
    
    await CMS.setMaintenanceMode(
      enabled,
      message,
      scheduledStart ? new Date(scheduledStart) : null,
      scheduledEnd ? new Date(scheduledEnd) : null
    );
    
    reply.send({
      success: true,
      message: 'Maintenance mode updated successfully'
    });
  } catch (error) {
    console.error('Set maintenance mode error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to update maintenance mode'
    });
  }
}

module.exports = {
  getHomepageData,
  getSlides,
  updateHomepage,
  addSlide,
  updateSlide,
  deleteSlide,
  getAnnouncements,
  addAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  setMaintenanceMode
};
