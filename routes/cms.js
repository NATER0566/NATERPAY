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
    reply.status(500).send({ success: false, message: 'Failed to fetch homepage data' });
  }
}

/**
 * Get slides (public and admin)
 * THE FIX: Ensure the array structure is perfectly flattened for the frontend.
 */
async function getSlides(request, reply) {
  try {
    const rawSlides = await CMS.getActiveSlides();
    
    // Normalize the data. Mongoose sometimes returns nested objects depending on the Schema.
    // We map it out strictly so index.html and admin.html can both read it perfectly.
    const cleanSlides = (rawSlides || []).map(slide => ({
      _id: slide._id,
      title: slide.title,
      caption: slide.caption || 'Welcome to the NATER-PAY ecosystem.',
      mediaUrl: slide.mediaUrl || slide.imageUrl,
      imageUrl: slide.mediaUrl || slide.imageUrl, // Send both keys to be safe
      ctaText: slide.ctaText || 'EXPLORE NOW',
      ctaLink: slide.ctaLink || slide.link || '#authTitle',
      link: slide.ctaLink || slide.link || '#authTitle' // Send both keys to be safe
    }));

    reply.send({
      success: true,
      data: cleanSlides,
      slides: cleanSlides
    });
  } catch (error) {
    console.error('Get slides error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch slides' });
  }
}

/**
 * Update homepage (admin)
 */
async function updateHomepage(request, reply) {
  try {
    const { siteName, logoUrl, tagline, rates } = request.body;
    
    await CMS.updateHomepage({ siteName, logoUrl, tagline, rates });
    
    if (request.server.io) {
      request.server.io.emit('cms_update');
    }
    
    reply.send({ success: true, message: 'Homepage updated successfully' });
  } catch (error) {
    console.error('Update homepage error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update homepage' });
  }
}

/**
 * Add slide (admin) - NOW ACCEPTS BASE64 IMAGES
 */
async function addSlide(request, reply) {
  try {
    const title = request.body.title;
    const mediaUrl = request.body.imageUrl || request.body.mediaUrl;
    const ctaLink = request.body.link || request.body.ctaLink || '#';
    const caption = request.body.caption || 'Welcome to the NATER-PAY Ecosystem.';
    const mediaType = request.body.mediaType || 'image';
    const ctaText = request.body.ctaText || 'EXPLORE NOW';
    
    if (!title || !mediaUrl) {
      return reply.status(400).send({ success: false, message: 'Title and image are required' });
    }
    
    await CMS.addSlide({
      title,
      caption,
      mediaType,
      mediaUrl, // Standardizing on mediaUrl for the database
      ctaText,
      ctaLink,
      order: request.body.order || 0
    });
    
    if (request.server.io) {
      request.server.io.emit('slides_refresh');
    }
    
    reply.send({ success: true, message: 'Slide published successfully' });
  } catch (error) {
    console.error('Add slide error:', error);
    reply.status(500).send({ success: false, message: 'Failed to add slide' });
  }
}

/**
 * Update slide (admin)
 */
async function updateSlide(request, reply) {
  try {
    const { id } = request.params;
    
    const updateData = {};
    if (request.body.title !== undefined) updateData.title = request.body.title;
    if (request.body.caption !== undefined) updateData.caption = request.body.caption;
    if (request.body.mediaType !== undefined) updateData.mediaType = request.body.mediaType;
    if (request.body.mediaUrl !== undefined) updateData.mediaUrl = request.body.mediaUrl;
    if (request.body.ctaText !== undefined) updateData.ctaText = request.body.ctaText;
    if (request.body.ctaLink !== undefined) updateData.ctaLink = request.body.ctaLink;
    if (request.body.order !== undefined) updateData.order = request.body.order;
    if (request.body.isActive !== undefined) updateData.isActive = request.body.isActive;
    
    await CMS.updateSlide(id, updateData);
    
    if (request.server.io) {
      request.server.io.emit('slides_refresh');
    }
    
    reply.send({ success: true, message: 'Slide updated successfully' });
  } catch (error) {
    console.error('Update slide error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update slide' });
  }
}

/**
 * Delete slide (admin)
 */
async function deleteSlide(request, reply) {
  try {
    const { id } = request.params;
    await CMS.deleteSlide(id);
    
    if (request.server.io) {
      request.server.io.emit('slides_refresh');
    }
    
    reply.send({ success: true, message: 'Slide deleted successfully' });
  } catch (error) {
    console.error('Delete slide error:', error);
    reply.status(500).send({ success: false, message: 'Failed to delete slide' });
  }
}

/**
 * Get announcements (public)
 */
async function getAnnouncements(request, reply) {
  try {
    const { targetAudience } = request.query;
    const announcements = await CMS.getActiveAnnouncements(targetAudience || 'all');
    reply.send({ success: true, data: announcements });
  } catch (error) {
    console.error('Get announcements error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch announcements' });
  }
}

/**
 * Add announcement (admin)
 */
async function addAnnouncement(request, reply) {
  try {
    const { title, message, type, isActive, startDate, endDate, targetAudience } = request.body;
    
    if (!title || !message) {
      return reply.status(400).send({ success: false, message: 'Title and message are required' });
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
    
    reply.send({ success: true, message: 'Announcement added successfully' });
  } catch (error) {
    console.error('Add announcement error:', error);
    reply.status(500).send({ success: false, message: 'Failed to add announcement' });
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
      title, message, type, isActive,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      targetAudience
    });
    
    reply.send({ success: true, message: 'Announcement updated successfully' });
  } catch (error) {
    console.error('Update announcement error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update announcement' });
  }
}

/**
 * Delete announcement (admin)
 */
async function deleteAnnouncement(request, reply) {
  try {
    const { id } = request.params;
    await CMS.deleteAnnouncement(id);
    reply.send({ success: true, message: 'Announcement deleted successfully' });
  } catch (error) {
    console.error('Delete announcement error:', error);
    reply.status(500).send({ success: false, message: 'Failed to delete announcement' });
  }
}

/**
 * Set maintenance mode (admin)
 */
async function setMaintenanceMode(request, reply) {
  try {
    const { enabled, message, scheduledStart, scheduledEnd } = request.body;
    await CMS.setMaintenanceMode( enabled, message, scheduledStart ? new Date(scheduledStart) : null, scheduledEnd ? new Date(scheduledEnd) : null );
    reply.send({ success: true, message: 'Maintenance mode updated successfully' });
  } catch (error) {
    console.error('Set maintenance mode error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update maintenance mode' });
  }
}

module.exports = {
  getHomepageData, getSlides, updateHomepage, addSlide, updateSlide, deleteSlide,
  getAnnouncements, addAnnouncement, updateAnnouncement, deleteAnnouncement, setMaintenanceMode
};
