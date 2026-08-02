// routes/koraTest.js
const express = require('express');
const router = express.Router();

router.post('/generate-test-account', async (req, res) => {
    // ALWAYS use the Secret Key (sk_test_...) for server-to-server API calls
    const KORA_SECRET_KEY = "sk_test_YOUR_SECRET_KEY_HERE"; 
    
    // Korapay Virtual Account Endpoint
    const url = "https://api.korapay.com/merchant/api/v1/virtual-bank-account";

    // Random reference string for testing
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
        // Using native fetch (Node 18+). If using older Node, swap this for axios.
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KORA_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        // Pass Korapay's exact response back to our frontend
        if (response.ok) {
            return res.status(200).json(data);
        } else {
            return res.status(response.status).json(data);
        }
    } catch (error) {
        console.error("Korapay API Error:", error);
        return res.status(500).json({ status: false, message: "Internal Server Error", error: error.message });
    }
});

module.exports = router;
