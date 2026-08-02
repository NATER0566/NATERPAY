// routes/koraTest.js
async function koraTestRoutes(fastify, options) {
    fastify.post('/generate-test-account', async (request, reply) => {
        // Pull Secret Key from environment variables
        const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY; 
        const url = "https://api.korapay.com/merchant/api/v1/virtual-bank-account";

        const testReference = `NATERPAY_TEST_${Date.now()}`;

        const payload = {
            account_name: "Nater Mbashau",
            account_reference: testReference,
            permanent: true,
            customer: {
                name: "Nater Mbashau",
                email: "testuser@naterpay.com"
            }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${KORA_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (response.ok) {
                return reply.code(200).send(data);
            } else {
                return reply.code(response.status).send(data);
            }
        } catch (error) {
            fastify.log.error("Korapay API Error:", error);
            return reply.code(500).send({ 
                status: false, 
                message: "Internal Server Error", 
                error: error.message 
            });
        }
    });
}

module.exports = koraTestRoutes;
