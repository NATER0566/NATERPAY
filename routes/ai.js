const { GoogleGenerativeAI } = require('@google/generative-ai');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const AIChat = require('../models/AIChat'); // Required to save chat history

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
// OFFICIAL FUNCTION CALLING LAYER
// =====================================================================
const tools = [
  {
    functionDeclarations: [
      { name: "checkWallet", description: "Fetch the user's current wallet and ledger balance." },
      { name: "getTransactions", description: "Fetch the user's recent transaction history." },
      { 
        name: "getTransaction", 
        description: "Fetch a specific transaction by reference number to check status or explain a failure.",
        parameters: { type: "OBJECT", properties: { reference: { type: "STRING" } }, required: ["reference"] }
      },
      { name: "getProfile", description: "Fetch the user's profile details." },
      { name: "getKYC", description: "Fetch the user's current KYC status, tier, and submitted documents." },
      { name: "getReferrals", description: "Fetch the user's referral tree, downlines, and total commissions earned." },
      { 
        name: "buyAirtime", 
        description: "Initiate an airtime purchase request.",
        parameters: { type: "OBJECT", properties: { network: { type: "STRING" }, amount: { type: "NUMBER" }, phone: { type: "STRING" } }, required: ["network", "amount", "phone"] }
      },
      { 
        name: "buyData", 
        description: "Initiate a data purchase request.",
        parameters: { type: "OBJECT", properties: { network: { type: "STRING" }, plan: { type: "STRING" }, phone: { type: "STRING" } }, required: ["network", "plan", "phone"] }
      },
      { 
        name: "payElectricity", 
        description: "Initiate an electricity bill payment.",
        parameters: { type: "OBJECT", properties: { disco: { type: "STRING" }, meterNumber: { type: "STRING" }, amount: { type: "NUMBER" } }, required: ["disco", "meterNumber", "amount"] }
      },
      { name: "buyEducationPin", description: "Initiate a WAEC or JAMB PIN purchase." },
      { name: "buyCable", description: "Initiate a DSTV, GOtv, or Startimes subscription." },
      { name: "checkBeneficiary", description: "Validate a saved beneficiary." },
      { 
        name: "lookupMeter", 
        description: "Verify an electricity meter number via VTpass API.",
        parameters: { type: "OBJECT", properties: { disco: { type: "STRING" }, meterNumber: { type: "STRING" } }, required: ["disco", "meterNumber"] }
      },
      { name: "lookupVariation", description: "Fetch available data/cable plans (variations) for a specific service." }
    ]
  }
];

// =====================================================================
// NATERPAY AI CHAT ROUTE
// =====================================================================
async function chatWithAI(request, reply) {
  try {
    const { message } = request.body;
    const userId = request.user._id; 
    
    if (!message) return reply.status(400).send({ success: false, message: 'Message is required.' });
    if (!process.env.GEMINI_API_KEY) return reply.status(500).send({ success: false, message: 'AI Core Offline. API Key missing.' });

    // [FIX 2] Moved initialization inside to guarantee .env is loaded
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // Save user's message to Database
    await AIChat.create({ user: userId, role: 'user', message: message });

    // [FIX 1] Changed to actual active model
    const liteEngine = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash", 
        systemInstruction: systemInstruction,
        tools: tools
    });

    const liteChat = liteEngine.startChat();
    const liteResult = await liteChat.sendMessage(message);
    const liteResponse = liteResult.response;
    
    // Check for Function Calling (SPS Layer)
    const functionCalls = liteResponse.functionCalls ? liteResponse.functionCalls() : [];
    
    if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0]; 
        let dbData = {};

        // Function Execution Layer
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
                    message: "AI cannot authorize direct fund deduction. Instruct the user to navigate to the respective dashboard page to complete this transaction." 
                };
                break;

            default:
                dbData = { error: "Function recognized but specific execution logic is pending implementation." };
        }

        // Deep Reasoning Engine
        const proEngine = genAI.getGenerativeModel({ 
            model: "gemini-1.5-pro", // Changed to actual Pro model
            systemInstruction: systemInstruction + "\n\nPRO DIRECTIVE: Your task right now is to analyze the raw system/database data provided to you. If there is a failed transaction, EXPLAIN the specific reason, cause, and solution clearly as an Error Explainer. Format beautifully with Markdown."
        });

        const proChat = proEngine.startChat({
            history: [{ role: "user", parts: [{ text: message }] }]
        });

        const proPayload = `System Context: The user asked a question and the system executed the '${call.name}' function. 
        Here is the raw database/system result: ${JSON.stringify(dbData)}. 
        Please format this information perfectly for the user according to your NATERPAY AI personality.`;

        // [FIX 3] Safely passing payload as a plain string
        const finalResult = await proChat.sendMessage(proPayload);
        const aiFinalText = finalResult.response.text();

        // Save AI response to Database
        await AIChat.create({ user: userId, role: 'model', message: aiFinalText, actionTaken: call.name });

        return reply.send({ success: true, reply: aiFinalText });
    }

    // No functions needed? Send standard text response.
    const standardText = liteResponse.text();
    await AIChat.create({ user: userId, role: 'model', message: standardText });

    return reply.send({ success: true, reply: standardText });

  } catch (error) {
    console.error("NATERPAY AI Error:", error);
    return reply.status(500).send({ success: false, message: 'Neural Core Processing Error' });
  }
}

module.exports = { chatWithAI };
