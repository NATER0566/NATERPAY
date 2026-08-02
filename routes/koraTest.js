// routes/koraTest.js
async function koraTestRoutes(fastify, options) {
    fastify.post('/generate-test-account', async (request, reply) => {
        const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY; 
        const url = "https://api.korapay.com/merchant/api/v1/virtual-bank-account";

        const testReference = `NATERPAY_TEST_${Date.now()}`;

        // PER KORAPAY DOCS: BVN must be inside a dedicated 'kyc' object
        const payload = {
            account_name: "Nater Mbashau",
            account_reference: testReference,
            permanent: true,
            bank_code: "000",
            currency: "NGN",
            customer: {
                name: "Nater Mbashau",
                email: "testuser@naterpay.com"
            },
            kyc: {
                bvn: "22222222222" // Standard 11-digit test BVN
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

            if (response.ok && data.status === true) {
                return reply.code(200).send(data);
            } else {
                let exactError = data.message || "Unknown API Error";
                
                if (data.error && typeof data.error === 'string') {
                    exactError = `${data.message}: ${data.error}`;
                } else if (data.data) {
                    exactError = `${data.message}: ${JSON.stringify(data.data)}`;
                }

                return reply.code(response.status || 400).send({ 
                    status: false, 
                    message: exactError 
                });
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
