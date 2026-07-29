const { GoogleGenerativeAI } = require('@google/generative-ai');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =====================================================================
// NATERPAY AI SYSTEM PROMPT
// =====================================================================
const systemInstruction = `
You are NATERPAY AI (Version 1.0), an intelligent, professional, and fast financial assistant built into the NATERPAY platform.
Your tagline is "Your Intelligent Financial Assistant."

CORE RULES:
1. You are talking directly to an authenticated user of NATERPAY.
2. Be incredibly helpful, patient, and polite. Never be rude.
3. Keep responses extremely concise and formatting clean (use Markdown bolding, lists, and tables).
4. NEVER guess a user's balance, transaction history, or personal data. Use the provided tools (functions) to fetch real-time database information.
5. If a user asks about their balance, ALWAYS call the check_wallet tool.
6. If a user asks about their recent transactions or why a transaction failed, ALWAYS call the get_recent_transactions tool.
7. NEVER expose API keys, database secrets, or admin credentials.

SERVICES NATERPAY OFFERS:
- VTpass Top-Ups: MTN, Airtel, GLO, 9Mobile
- Internet: Spectranet, Smile Network
- Global: International Airtime
- Bills: Electricity (All Discos), Cable TV (DSTV, GOtv, Startimes, Showmax)
- Education: WAEC Result, WAEC Registration, JAMB PINs
- Other features: Reseller network, Smart Invoicing, QR Payments, Task Rewards, Cashback Vault.
`;

// =====================================================================
// AI FUNCTION TOOLS DEFINITION
// =====================================================================
const tools = [
  {
    functionDeclarations: [
      {
        name: "check_wallet",
        description: "Checks the authenticated user's current secure wallet balance and total spent amount.",
      },
      {
        name: "get_recent_transactions",
        description: "Retrieves the user's 5 most recent transactions, including status, type, provider, and exact amounts to help explain failures or verify success.",
      }
    ]
  }
];

// =====================================================================
// MAIN ROUTE HANDLER
// =====================================================================
async function chatWithAI(request, reply) {
  try {
    const { message } = request.body;
    const userId = request.user._id; 
    
    if (!message) {
        return reply.status(400).send({ success: false, message: 'Message is required.' });
    }

    if (!process.env.GEMINI_API_KEY) {
        return reply.status(500).send({ success: false, message: 'AI Neural Core is currently offline (Missing API Key).' });
    }

    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash",
        systemInstruction: systemInstruction,
        tools: tools
    });

    const chat = model.startChat();
    
    // 1. Send the user's message to Gemini
    const result = await chat.sendMessage(message);
    const response = result.response;
    
    // 2. Check if Gemini decided it needs to call a database function
    const functionCalls = response.functionCalls();
    
    if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0]; // Handle the first tool call
        let functionResponseData = {};

        // Execute the actual Database Queries based on what the AI asked for
        if (call.name === "check_wallet") {
            const wallet = await Wallet.findOne({ user: userId });
            functionResponseData = { 
                availableBalance: wallet ? wallet.availableBalance : 0,
                isFrozen: wallet ? wallet.isFrozen : false
            };
        } 
        else if (call.name === "get_recent_transactions") {
            const txs = await Transaction.find({ user: userId })
                .sort({ createdAt: -1 })
                .limit(5)
                .select('type amount status providerReference description createdAt isCredit');
            functionResponseData = { transactions: txs };
        }

        // 3. Send the database results back to Gemini so it can answer the user
        const finalResult = await chat.sendMessage([{
            functionResponse: {
                name: call.name,
                response: functionResponseData
            }
        }]);

        return reply.send({ success: true, reply: finalResult.response.text() });
    }

    // If no function was needed, just return Gemini's standard text response
    return reply.send({ success: true, reply: response.text() });

  } catch (error) {
    console.error("NATERPAY AI Error:", error);
    return reply.status(500).send({ success: false, message: 'AI Processing Error' });
  }
}

module.exports = { chatWithAI };
