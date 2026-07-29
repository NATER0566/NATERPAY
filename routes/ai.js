const { GoogleGenerativeAI } = require('@google/generative-ai');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
// OFFICIAL FUNCTION CALLING LAYER (14 SPECIFIED FUNCTIONS)
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
// DUAL-ENGINE ARCHITECTURE SETUP
// =====================================================================

// ENGINE 1: FLASH-LITE (Frontline Router & Action Executor)
// Extremely fast, handles simple chat and decides which function to trigger.
const liteEngine = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash-lite",
    systemInstruction: systemInstruction,
    tools: tools
});

// ENGINE 2: FLASH (The Heavy Lifter)
// Triggered for Error Explanations, Developer Assistance, and deep reasoning.
const proEngine = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    systemInstruction: systemInstruction + "\n\nPRO DIRECTIVE: Your task right now is to analyze the raw system/database data provided to you. If there is a failed transaction, EXPLAIN the specific reason, cause, and solution clearly as an Error Explainer. Format beautifully with Markdown."
});

// =====================================================================
// NATERPAY AI CHAT ROUTE
// =====================================================================
async function chatWithAI(request, reply) {
  try {
    const { message } = request.body;
    const userId = request.user._id; 
    
    if (!message) return reply.status(400).send({ success: false, message: 'Message is required.' });
    if (!process.env.GEMINI_API_KEY) return reply.status(500).send({ success: false, message: 'AI Core Offline.' });

    // Step 1: Route to Lite Engine
    const liteChat = liteEngine.startChat();
    const liteResult = await liteChat.sendMessage(message);
    const liteResponse = liteResult.response;
    
    // Step 2: Check for Function Calling (SPS Layer)
    const functionCalls = liteResponse.functionCalls();
    
    if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0]; 
        let dbData = {};

        // -------------------------------------------------------------
        // FUNCTION CALLING LAYER EXECUTION
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
                const user = await User.findById(userId).select('fullName email phone role isVerified');
                dbData = { profile: user };
                break;

            case "getReferrals":
                dbData = { message: "Referral fetching triggered. Data synced from network tree." };
                // Add actual referral DB query here when needed
                break;

            case "buyAirtime":
            case "buyData":
            case "payElectricity":
            case "buyCable":
            case "buyEducationPin":
                dbData = { 
                    action: call.name, 
                    status: "Action Prepared", 
                    message: "AI cannot authorize direct fund deduction. Instruct the user to navigate to the respective dashboard page to complete this transaction with their Security PIN." 
                };
                break;

            case "lookupMeter":
                dbData = { status: "Lookup initiated", message: `Checking meter ${call.args.meterNumber} for ${call.args.disco}.` };
                // Call VTpass meter verification logic here
                break;

            default:
                dbData = { error: "Function recognized but execution logic is pending implementation." };
        }

        // Step 3: Pass raw data to PRO Engine for deep reasoning and explanation
        const proChat = proEngine.startChat({
            history: [{ role: "user", parts: [{ text: message }] }]
        });

        const proPayload = `System Context: The user asked a question and the system executed the '${call.name}' function. 
        Here is the raw database/system result: ${JSON.stringify(dbData)}. 
        Please format this information perfectly for the user according to your NATERPAY AI personality. If it is an error or a failed transaction, act as the Error Explainer.`;

        const finalResult = await proChat.sendMessage([{ text: proPayload }]);

        return reply.send({ success: true, reply: finalResult.response.text() });
    }

    // Step 4: No functions needed? Fast response from Lite Engine.
    return reply.send({ success: true, reply: liteResponse.text() });

  } catch (error) {
    console.error("NATERPAY AI Error:", error);
    return reply.status(500).send({ success: false, message: 'Neural Core Processing Error' });
  }
}

module.exports = { chatWithAI };
