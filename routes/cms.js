const CMS = require('../models/CMS');
const cloudinary = require('cloudinary').v2;

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
 */
async function getSlides(request, reply) {
  try {
    const rawSlides = await CMS.getActiveSlides();
    
    const cleanSlides = (rawSlides || []).map(slide => ({
      _id: slide._id,
      title: slide.title,
      caption: slide.caption || 'Welcome to the NATER-PAY ecosystem.',
      mediaUrl: slide.mediaUrl || slide.imageUrl,
      imageUrl: slide.mediaUrl || slide.imageUrl,
      type: slide.type || slide.mediaType || 'image',
      ctaText: slide.ctaText || 'EXPLORE NOW',
      ctaLink: slide.ctaLink || slide.link || '#authTitle',
      link: slide.ctaLink || slide.link || '#authTitle'
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
 * Add slide (admin) - UPGRADED WITH CLOUDINARY ENGINE
 */
async function addSlide(request, reply) {
  try {
    const { title, caption, ctaText, link, type, mediaData } = request.body;
    
    if (!title) {
      return reply.status(400).send({ success: false, message: 'Title is required' });
    }

    let finalMediaUrl = '';

    if (mediaData && type !== 'text') {
        try {
            if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
                cloudinary.config({
                    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
                    api_key: process.env.CLOUDINARY_API_KEY,
                    api_secret: process.env.CLOUDINARY_API_SECRET
                });

                const resourceType = type === 'video' ? 'video' : 'image';
                const uploadRes = await cloudinary.uploader.upload(mediaData, {
                    resource_type: resourceType,
                    folder: 'naterpay/slides'
                });
                
                finalMediaUrl = uploadRes.secure_url;
            } else {
                finalMediaUrl = mediaData;
            }
        } catch (uploadError) {
            console.error('Cloudinary Upload Failed:', uploadError);
            return reply.status(500).send({ success: false, message: 'Failed to upload media to Cloudinary.' });
        }
    }
    
    await CMS.addSlide({
      title,
      caption: caption || '',
      type: type || 'image',
      mediaType: type || 'image',
      mediaUrl: finalMediaUrl, 
      imageUrl: finalMediaUrl,
      ctaText: ctaText || 'EXPLORE NOW',
      ctaLink: link || '#',
      link: link || '#',
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
    if (request.body.type !== undefined) updateData.type = request.body.type;
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

/**
 * Get founder profile (public)
 */
async function getFounderProfile(request, reply) {
  try {
    const cmsData = await CMS.findOne();
    reply.send({ 
      success: true, 
      founder: cmsData?.founderProfile || {
        name: 'Nater Mbashau',
        title: 'Chief Executive Officer & Lead Architect',
        academic: '300L Computer Science • Nasarawa State University, Keffi',
        bio: 'Operating under the professional architecture of NATER GRACE CODE...',
        photoUrl: ''
      } 
    });
  } catch (error) {
    console.error('Get founder profile error:', error);
    reply.status(500).send({ success: false, message: 'Failed to fetch founder profile' });
  }
}

/**
 * Update founder profile (admin)
 */
async function updateFounderProfile(request, reply) {
  try {
    const { name, title, academic, bio, mediaData } = request.body;
    
    let cmsData = await CMS.findOne();
    if (!cmsData) {
      cmsData = new CMS();
    }

    if (!cmsData.founderProfile) {
      cmsData.founderProfile = {};
    }

    cmsData.founderProfile.name = name || cmsData.founderProfile.name;
    cmsData.founderProfile.title = title || cmsData.founderProfile.title;
    cmsData.founderProfile.academic = academic || cmsData.founderProfile.academic;
    cmsData.founderProfile.bio = bio || cmsData.founderProfile.bio;

    if (mediaData) {
      try {
        if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
          cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
          });

          const uploadRes = await cloudinary.uploader.upload(mediaData, {
            resource_type: 'image',
            folder: 'naterpay/founder'
          });
          
          cmsData.founderProfile.photoUrl = uploadRes.secure_url;
        } else {
          cmsData.founderProfile.photoUrl = mediaData;
        }
      } catch (uploadError) {
        console.error('Founder Photo Cloudinary Upload Failed:', uploadError);
        return reply.status(500).send({ success: false, message: 'Failed to upload founder photo to Cloudinary.' });
      }
    }

    await cmsData.save();

    if (request.server.io) {
      request.server.io.emit('cms_update');
    }

    reply.send({ success: true, message: 'Founder profile updated successfully', founder: cmsData.founderProfile });
  } catch (error) {
    console.error('Update founder profile error:', error);
    reply.status(500).send({ success: false, message: 'Failed to update founder profile' });
  }
}

// Ensure EVERYTHING is exported so server.js can find it
module.exports = {
  getHomepageData, getSlides, updateHomepage, addSlide, updateSlide, deleteSlide,
  getAnnouncements, addAnnouncement, updateAnnouncement, deleteAnnouncement, setMaintenanceMode,
  getFounderProfile, updateFounderProfile
};
