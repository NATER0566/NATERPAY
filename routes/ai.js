const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Safely require AIChat so it never crashes the app if the file is missing or corrupt
let AIChat;
try { AIChat = require('../models/AIChat'); } catch (e) { console.warn("AIChat model not found. Chat history will not be saved."); }

// =====================================================================
// NATERPAY AI OFFICIAL SYSTEM SPECIFICATION (SPS v1.0)
// =====================================================================
const systemInstruction = `
You are NATERPAY AI.
Tagline: "Your Intelligent Financial Assistant."

PRIMARY OBJECTIVE:
You are an intelligent financial assistant built into NATERPAY. 
Your mission: Help users use NATERPAY, solve problems instantly, guide transactions, explain failures, answer fintech questions, teach new users, help developers, and protect users from fraud. You are the smartest page inside NATERPAY.

PERSONALITY:
Professional, Friendly, Fast, Secure, Accurate, Patient, Helpful. Never rude. Never hallucinate. Never expose secrets.

MAIN FEATURES & CAPABILITIES:
1. GENERAL ASSISTANT: Answer every NATERPAY question.
2. TRANSACTION ASSISTANT: Check status (Pending, Failed, Successful), explain reasons for failure, provide reference numbers and receipts.
3. WALLET ASSISTANT: Check Wallet Balance, Ledger Balance, Funding, Withdrawal, Recent Transactions, Wallet Security.
4. VTPASS ASSISTANT: Guide users on MTN, Airtel, GLO, 9mobile, Spectranet, Smile, International Airtime, Electricity, DSTV, GOtv, Startimes, Showmax, WAEC, WAEC Registration, JAMB.
5. ERROR EXPLAINER: Do not just say "Transaction Failed." Explain Reason, Cause, Solution, Example (e.g., Wrong Meter, Insufficient Balance, Service Down, Wrong Variation, Timeout, Provider Error).
6. SECURITY ASSISTANT: Guide on Password, OTP, KYC, Scam Prevention, Account Lock, Identity Protection, Fraud Awareness.
7. KYC ASSISTANT: Explain Verification, Documents, BVN, NIN, Approval, Rejected Documents.
8. REFERRAL ASSISTANT: Explain Referral Link, Commission, Referral Earnings, Invite Friends, Referral Tree.
9. MERCHANT ASSISTANT: Explain Invoices, Payment Links, Analytics, Reseller, Merchant Dashboard.
10. DEVELOPER ASSISTANT: Help with API, Webhooks, VTpass, Paystack, Integration, Node.js, Examples, Documentation.

SAFETY & GUARDRAILS:
- NEVER reveal API Keys, JWT Secrets, Database info, Passwords, Environment Variables, or Admin Credentials.
- NEVER invent or hallucinate Wallet Balances, Transactions, Commissions, or Statuses. ALWAYS use function calling.
- ALWAYS maintain context and remember previous messages.
- Keep formatting clean using Markdown (bolding, lists, code blocks).
`;

// =====================================================================
// OFFICIAL FUNCTION CALLING LAYER (v0.21.0 COMPLIANT SCHEMA)
// =====================================================================
// Functions with no parameters must omit the 'parameters' key entirely
const tools = [
  {
    functionDeclarations: [
      { name: "checkWallet", description: "Fetch the user's current wallet and ledger balance." },
      { name: "getTransactions", description: "Fetch the user's recent transaction history." },
      { 
        name: "getTransaction", 
        description: "Fetch a specific transaction by reference number to check status or explain a failure.",
        parameters: { type: SchemaType.OBJECT, properties: { reference: { type: SchemaType.STRING } }, required: ["reference"] }
      },
      { name: "getProfile", description: "Fetch the user's profile details." },
      { name: "getKYC", description: "Fetch the user's current KYC status, tier, and submitted documents." },
      { name: "getReferrals", description: "Fetch the user's referral tree, downlines, and total commissions earned." },
      { 
        name: "buyAirtime", 
        description: "Initiate an airtime purchase request.",
        parameters: { type: SchemaType.OBJECT, properties: { network: { type: SchemaType.STRING }, amount: { type: SchemaType.NUMBER }, phone: { type: SchemaType.STRING } }, required: ["network", "amount", "phone"] }
      },
      { 
        name: "buyData", 
        description: "Initiate a data purchase request.",
        parameters: { type: SchemaType.OBJECT, properties: { network: { type: SchemaType.STRING }, plan: { type: SchemaType.STRING }, phone: { type: SchemaType.STRING } }, required: ["network", "plan", "phone"] }
      },
      { 
        name: "payElectricity", 
        description: "Initiate an electricity bill payment.",
        parameters: { type: SchemaType.OBJECT, properties: { disco: { type: SchemaType.STRING }, meterNumber: { type: SchemaType.STRING }, amount: { type: SchemaType.NUMBER } }, required: ["disco", "meterNumber", "amount"] }
      },
      { name: "buyEducationPin", description: "Initiate a WAEC or JAMB PIN purchase." },
      { name: "buyCable", description: "Initiate a DSTV, GOtv, or Startimes subscription." },
      { name: "checkBeneficiary", description: "Validate a saved beneficiary." },
      { 
        name: "lookupMeter", 
        description: "Verify an electricity meter number via VTpass API.",
        parameters: { type: SchemaType.OBJECT, properties: { disco: { type: SchemaType.STRING }, meterNumber: { type: SchemaType.STRING } }, required: ["disco", "meterNumber"] }
      },
      { name: "lookupVariation", description: "Fetch available data/cable plans (variations) for a specific service." }
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

    // Save user's prompt
    await saveChat(userId, 'user', message);

    // Use the official v0.21.0 model & config
    const aiEngine = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash", 
        systemInstruction: systemInstruction,
        tools: tools
    });

    const chat = aiEngine.startChat();
    const result = await chat.sendMessage(message);
    const response = result.response;
    
    // Extract Function Calls
    let functionCalls = response.functionCalls ? (typeof response.functionCalls === 'function' ? response.functionCalls() : response.functionCalls) : [];
    
    if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0]; 
        let dbData = {};

        // -------------------------------------------------------------
        // EXECUTE SYSTEM ACTION
        // -------------------------------------------------------------
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

        // -------------------------------------------------------------
        // PASS DATA BACK TO AI FOR NATURAL LANGUAGE EXPLANATION
        // -------------------------------------------------------------
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

    // Standard text response if no function was needed
    const standardText = typeof response.text === 'function' ? response.text() : response.text;
    await saveChat(userId, 'model', standardText);

    return reply.send({ success: true, reply: standardText });

  } catch (error) {
    console.error("NATERPAY AI Error:", error);
    const errorMsg = error.message || "Unknown API Error";
    
    // Graceful error handling rendering back to the chat UI
    return reply.send({ 
        success: true, 
        reply: `⚠️ **Diagnostic Alert:** The neural core encountered a critical error.\n\n\`\`\`text\n${errorMsg}\n\`\`\`\n*If you are the developer, check the error code above to debug the Google API connection.*` 
    });
  }
}

module.exports = { chatWithAI };
