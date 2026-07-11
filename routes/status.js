const mongoose = require('mongoose');

async function getSystemStatus(request, reply) {
    try {
        // 1. Check actual MongoDB connection state
        // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
        const dbState = mongoose.connection.readyState;
        const isDbOnline = dbState === 1;

        // 2. Define the real-time status object
        const statusReport = {
            success: true,
            services: {
                // If this route is successfully hit, the Fastify API is online
                api: 'online', 
                // Reflects the real MongoDB Atlas connection
                database: isDbOnline ? 'online' : 'offline', 
                // For a true enterprise app, these can eventually ping Paystack/VTpass servers
                payment: 'online', 
                vtu: 'online'
            },
            // Simulated 30-day uptimes (You can wire these to a real Analytics DB later)
            uptime: {
                api: 99.98,
                database: 99.95,
                payment: 99.99
            },
            timestamp: new Date()
        };

        // Send the real data back to status.html
        reply.send(statusReport);

    } catch (error) {
        // If the server crashes during checks, return offline state
        reply.status(500).send({
            success: false,
            message: 'Failed to retrieve system status'
        });
    }
}

module.exports = { getSystemStatus };
