const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');

/**
 * Get user's support tickets
 */
async function getTickets(request, reply) {
  try {
    const tickets = await SupportTicket.findByUser(request.user._id);
    
    reply.send({
      success: true,
      tickets: tickets.map(ticket => ({
        _id: ticket._id,
        ticketId: ticket.ticketId,
        subject: ticket.subject,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        createdAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt
      }))
    });
  } catch (error) {
    console.error('Get tickets error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch support tickets'
    });
  }
}

/**
 * Create support ticket
 */
async function createTicket(request, reply) {
  try {
    const { subject, category, priority, description, relatedTransaction } = request.body;
    
    if (!subject || !category || !description) {
      return reply.status(400).send({
        success: false,
        message: 'Subject, category, and description are required'
      });
    }
    
    const ticket = new SupportTicket({
      user: request.user._id,
      subject,
      category,
      priority: priority || 'medium',
      description,
      relatedTransaction
    });
    
    await ticket.save();
    
    await Notification.create({
      user: request.user._id,
      title: 'Support Ticket Created',
      message: `Your support ticket ${ticket.ticketId} has been created`,
      type: 'support',
      priority: 'medium'
    });
    
    reply.status(201).send({
      success: true,
      message: 'Support ticket created successfully',
      ticket: {
        _id: ticket._id,
        ticketId: ticket.ticketId
      }
    });
  } catch (error) {
    console.error('Create ticket error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to create support ticket'
    });
  }
}

/**
 * Get single ticket with messages
 */
async function getTicket(request, reply) {
  try {
    const { ticketId } = request.params;
    
    const ticket = await SupportTicket.findByTicketId(ticketId);
    
    if (!ticket) {
      return reply.status(404).send({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    if (ticket.user._id.toString() !== request.user._id.toString() && 
        !['admin', 'superadmin'].includes(request.user.role)) {
      return reply.status(403).send({
        success: false,
        message: 'Access denied'
      });
    }
    
    reply.send({
      success: true,
      ticket: {
        _id: ticket._id,
        ticketId: ticket.ticketId,
        subject: ticket.subject,
        category: ticket.category,
        priority: ticket.priority,
        description: ticket.description,
        status: ticket.status,
        assignedTo: ticket.assignedTo,
        assignedAt: ticket.assignedAt,
        resolution: ticket.resolution,
        resolvedAt: ticket.resolvedAt,
        relatedTransaction: ticket.relatedTransaction,
        createdAt: ticket.createdAt,
        messages: ticket.messages.map(msg => ({
          _id: msg._id,
          user: msg.user,
          message: msg.message,
          isInternal: msg.isInternal,
          attachments: msg.attachments,
          createdAt: msg.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('Get ticket error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch ticket'
    });
  }
}

/**
 * Add message to ticket
 */
async function addMessage(request, reply) {
  try {
    const { ticketId } = request.params;
    const { message, isInternal, attachments } = request.body;
    
    if (!message) {
      return reply.status(400).send({
        success: false,
        message: 'Message is required'
      });
    }
    
    const ticket = await SupportTicket.findByTicketId(ticketId);
    
    if (!ticket) {
      return reply.status(404).send({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    if (ticket.user._id.toString() !== request.user._id.toString() && 
        !['admin', 'superadmin'].includes(request.user.role)) {
      return reply.status(403).send({
        success: false,
        message: 'Access denied'
      });
    }
    
    await ticket.addMessage(request.user._id, message, isInternal || false, attachments || []);
    
    // If user replied and ticket was resolved, reopen it
    if (request.user._id.toString() === ticket.user._id.toString() && ticket.status === 'resolved') {
      await ticket.reopen();
    }
    
    await Notification.create({
      user: ticket.user._id,
      title: 'New Message on Ticket',
      message: `A new message has been added to ticket ${ticket.ticketId}`,
      type: 'support',
      priority: 'medium'
    });
    
    reply.send({
      success: true,
      message: 'Message added successfully'
    });
  } catch (error) {
    console.error('Add message error:', error);
    reply.status(500).send({
      success: false,
      message: 'Failed to add message'
    });
  }
}

module.exports = {
  getTickets,
  createTicket,
  getTicket,
  addMessage
};
