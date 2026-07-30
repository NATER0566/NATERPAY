const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Safely require AIChat so it never crashes the app if the file is missing or corrupt
let AIChat;
try { AIChat = require('../models/AIChat'); } catch (e) { console.warn("AIChat model not found. Chat history will not be saved."); }

// Ensure SchemaType is available
const TYPE_OBJECT = SchemaType?.OBJECT || "OBJECT";
const TYPE_STRING = SchemaType?.STRING || "STRING";
const TYPE_NUMBER = SchemaType?.NUMBER || "NUMBER";

// =====================================================================
// NATERPAY AI OFFICIAL SYSTEM SPECIFICATION (SPS v2.0)
// =====================================================================
const systemInstruction = `
You are NATERPAY AI.
Tagline: "Your Intelligent Financial Assistant."

PRIMARY OBJECTIVE:
You are the central intelligence built directly into the NATERPAY database. 
Your mission is to provide 100% accurate, live data to the user regarding their account, transactions, wallet, and our fintech services. 

STRICT KNOWLEDGE & GUARDRAILS:
1. NO HALLUCINATION: You must NEVER invent, guess, or force information. If a user asks about their balance or a transaction, you MUST use the provided function tools to fetch the exact data.
2. ESCALATION PROTOCOL: If a user asks a question you cannot answer, or requests an action outside your capabilities, you MUST reply exactly with: "I cannot provide that information. Please contact the support team or the founder, Nater Mbashau, for further assistance."
3. FOUNDER KNOWLEDGE: The founder and owner of NATERPAY is Nater Mbashau.
4. SECRECY: Never reveal API Keys, JWT Secrets, Database info, Passwords, Environment Variables, or Admin Credentials.

MAIN FEATURES & CAPABILITIES:
- Answer every NATERPAY question accurately based on the tools provided.
- Check status (Pending, Failed, Successful) and explain reasons for failure.
- Check Wallet Balance, Ledger Balance, Funding, Withdrawal, Recent Transactions.
- Guide users on VTpass services (MTN, Airtel, GLO, 9mobile, Electricity, DSTV, GOtv, Startimes, WAEC, JAMB).
- Explain errors clearly (e.g., Wrong Meter, Insufficient Balance, Provider Error).
- Provide guidance on KYC, Referrals, and Merchant setups.

Keep your formatting clean using Markdown (bolding, lists, code blocks). Remember: Accuracy over everything. If you do not know, refer them to Nater Mbashau or Support.
`;

// =====================================================================
// OFFICIAL FUNCTION CALLING LAYER 
// =====================================================================
const tools = [
  {
    functionDeclarations: [
      { name: "checkWallet", description: "Fetch the user's current wallet and ledger balance." },
      { name: "getTransactions", description: "Fetch the user's recent transaction history." },
      { name: "getProfile", description: "Fetch the user's profile details." },
      { name: "getKYC", description: "Fetch the user's current KYC status, tier, and submitted documents." },
      { name: "getReferrals", description: "Fetch the user's referral tree, downlines, and total commissions earned." },
      { name: "buyEducationPin", description: "Initiate a WAEC or JAMB PIN purchase." },
      { name: "buyCable", description: "Initiate a DSTV, GOtv, or Startimes subscription." },
      { name: "checkBeneficiary", description: "Validate a saved beneficiary." },
      { name: "lookupVariation", description: "Fetch available data/cable plans (variations) for a specific service." },
      { 
        name: "getTransaction", 
        description: "Fetch a specific transaction by reference number to check status or explain a failure.",
        parameters: { type: TYPE_OBJECT, properties: { reference: { type: TYPE_STRING } }, required: ["reference"] }
      },
      { 
        name: "buyAirtime", 
        description: "Initiate an airtime purchase request.",
        parameters: { type: TYPE_OBJECT, properties: { network: { type: TYPE_STRING }, amount: { type: TYPE_NUMBER }, phone: { type: TYPE_STRING } }, required: ["network", "amount", "phone"] }
      },
      { 
        name: "buyData", 
        description: "Initiate a data purchase request.",
        parameters: { type: TYPE_OBJECT, properties: { network: { type: TYPE_STRING }, plan: { type: TYPE_STRING }, phone: { type: TYPE_STRING } }, required: ["network", "plan", "phone"] }
      },
      { 
        name: "payElectricity", 
        description: "Initiate an electricity bill payment.",
        parameters: { type: TYPE_OBJECT, properties: { disco: { type: TYPE_STRING }, meterNumber: { type: TYPE_STRING }, amount: { type: TYPE_NUMBER } }, required: ["disco", "meterNumber", "amount"] }
      },
      { 
        name: "lookupMeter", 
        description: "Verify an electricity meter number via VTpass API.",
        parameters: { type: TYPE_OBJECT, properties: { disco: { type: TYPE_STRING }, meterNumber: { type: TYPE_STRING } }, required: ["disco", "meterNumber"] }
      }
    ]
  }
];

// Helper to safely save chat history
async function saveChat(userId, role, message, actionTaken = null) {
    if (AIChat) {
        try { await AIChat.create({ user: userId, role, message, actionTaken }); } 
        catch(e) { console.error("Chat Logging Error:", e.message); }
    }
}

// =====================================================================
// NATERPAY AI CHAT ROUTE
// =====================================================================
async function chatWithAI(request, reply) {
  try {
    const { message } = request.body;
    const userId = request.user._id; 
    
    if (!message) return reply.status(400).send({ success: false, message: 'Message is required.' });
    
    if (!process.env.GEMINI_API_KEY) {
        return reply.send({ success: true, reply: "⚠️ **System Alert:** `GEMINI_API_KEY` is missing from your environment variables. Please add it to your Render dashboard." });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    await saveChat(userId, 'user', message);

    const aiEngine = genAI.getGenerativeModel({ 
        model: "gemini-3.6-flash", 
        systemInstruction: systemInstruction,
        tools: tools
    });

    const chat = aiEngine.startChat();
    const result = await chat.sendMessage(message);
    const response = result.response;
    
    let functionCalls = response.functionCalls ? (typeof response.functionCalls === 'function' ? response.functionCalls() : response.functionCalls) : [];
    
    if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0]; 
        let dbData = {};

        switch(call.name) {
            case "checkWallet":
                const wallet = await Wallet.findOne({ user: userId });
                dbData = { availableBalance: wallet?.availableBalance || 0, ledgerBalance: wallet?.ledgerBalance || 0, isFrozen: wallet?.isFrozen || false };
                break;
                
            case "getTransactions":
                const txs = await Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(5).select('type amount status providerReference description createdAt');
                dbData = { recentTransactions: txs };
                break;
                
            case "getTransaction":
                const singleTx = await Transaction.findOne({ user: userId, providerReference: call.args.reference });
                dbData = { transaction: singleTx || "Transaction not found." };
                break;

            case "getProfile":
                const user = await User.findById(userId).select('name email phone role isVerified');
                dbData = { profile: user };
                break;

            case "buyAirtime":
            case "buyData":
            case "payElectricity":
            case "buyCable":
            case "buyEducationPin":
                dbData = { 
                    action: call.name, 
                    status: "Action Prepared", 
                    message: "Inform the user that AI cannot authorize direct deductions. Instruct them to navigate to the respective dashboard service page to complete the transaction securely with their PIN." 
                };
                break;

            default:
                dbData = { status: "Acknowledged", message: "Function executed successfully." };
        }

        const finalResult = await chat.sendMessage([{
            functionResponse: {
                name: call.name,
                response: dbData
            }
        }]);

        const aiFinalText = typeof finalResult.response.text === 'function' ? finalResult.response.text() : finalResult.response.text;
        await saveChat(userId, 'model', aiFinalText, call.name);
        
        return reply.send({ success: true, reply: aiFinalText });
    }

    const standardText = typeof response.text === 'function' ? response.text() : response.text;
    await saveChat(userId, 'model', standardText);

    return reply.send({ success: true, reply: standardText });

  } catch (error) {
    console.error("NATERPAY AI Error:", error);
    const errorMsg = error.message || "Unknown API Error";
    
    return reply.send({ 
        success: true, 
        reply: `⚠️ **Diagnostic Alert:** The neural core encountered a critical error.\n\n\`\`\`text\n${errorMsg}\n\`\`\`\n*If you are the developer, check the error code above to debug the Google API connection.*` 
    });
  }
}

module.exports = { chatWithAI };
