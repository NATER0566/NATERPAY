const Notification = require('../models/Notification');

/**
 * Get user notifications
 */
async function getNotifications(request, reply) {
  try {
    const { unreadOnly, type, limit = 50 } = request.query;
    
    const options = { limit: parseInt(limit) };
    if (unreadOnly === 'true') options.unreadOnly = true;
    if (type) options.type = type;
    
    const notifications = await Notification.findByUser(request.user._id, options);
    const unreadCount = await Notification.findUnreadCount(request.user._id);
    
    reply.send({
      success: true,
      notifications: notifications.map(notif => ({
        _id: notif._id,
        title: notif.title,
        message: notif.message,
        type: notif.type,
        priority: notif.priority,
        actionLink: notif.actionLink,
        actionLabel: notif.actionLabel,
        isRead: notif.isRead,
        readAt: notif.readAt,
        createdAt: notif.createdAt
      })),
      unreadCount
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch notifications'
    });
  }
}

/**
 * Mark notification as read
 */
async function markAsRead(request, reply) {
  try {
    const { id } = request.params;
    
    const notification = await Notification.findOne({
      _id: id,
      user: request.user._id
    });
    
    if (!notification) {
      return reply.status(404).send({
        success: false,
        message: 'Notification not found'
      });
    }
    
    await notification.markAsRead();
    
    reply.send({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to mark notification as read'
    });
  }
}

/**
 * Mark all notifications as read
 */
async function markAllAsRead(request, reply) {
  try {
    await Notification.markAllAsRead(request.user._id);
    
    reply.send({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all as read error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to mark all notifications as read'
    });
  }
}

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead
};
