'use strict';

const { GoogleGenAI, Type } = require('@google/genai');

const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Optional models.
// The AI route must NOT crash if these models do not exist.
let AIChat = null;
let Creator = null;
let KYC = null;
let Referral = null;
let Beneficiary = null;

try {
  AIChat = require('../models/AIChat');
} catch (err) {
  console.warn('[NATERPAY AI] AIChat model not found. Chat history disabled.');
}

try {
  Creator = require('../models/Creator');
} catch (err) {
  console.warn('[NATERPAY AI] Creator model not found.');
}

try {
  KYC = require('../models/KYC');
} catch (err) {
  console.warn('[NATERPAY AI] KYC model not found.');
}

try {
  Referral = require('../models/Referral');
} catch (err) {
  console.warn('[NATERPAY AI] Referral model not found.');
}

try {
  Beneficiary = require('../models/Beneficiary');
} catch (err) {
  console.warn('[NATERPAY AI] Beneficiary model not found.');
}

/*
|--------------------------------------------------------------------------
| GEMINI CONFIGURATION
|--------------------------------------------------------------------------
*/

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const SYSTEM_INSTRUCTION = `
You are NATERPAY AI.
Tagline: "Your Intelligent Financial Assistant."

You are the official intelligent financial assistant inside NATERPAY.

PRIMARY OBJECTIVE:
Help authenticated NATERPAY users understand their account, wallet,
transactions, KYC, referrals and NATERPAY services.

IMPORTANT RULES:

1. NEVER INVENT FINANCIAL INFORMATION.

If the user asks about:
- wallet balance
- ledger balance
- transaction status
- transaction history
- KYC
- profile
- referrals

you MUST use the appropriate database tool.

2. NEVER GUESS.

If the database does not contain the requested information, clearly say
that the information could not be found.

3. SECURITY.

Never reveal:
- API keys
- JWT secrets
- passwords
- PINs
- database credentials
- environment variables
- admin credentials
- internal security configuration

4. FINANCIAL ACTIONS.

You must NEVER directly authorize or perform money deductions.

For:
- airtime purchases
- data purchases
- electricity payments
- cable subscriptions
- WAEC/JAMB purchases

you may explain the service and prepare the requested action,
but the actual financial transaction must be completed through
NATERPAY's secure transaction flow.

Never tell the user that money was deducted unless the backend
database confirms it.

5. FOUNDER.

The founder of NATERPAY is Nater Mbashau.

6. SERVICES.

NATERPAY supports services including:
- MTN
- Airtel
- GLO
- 9mobile
- Electricity
- DSTV
- GOtv
- Startimes
- WAEC
- JAMB
- KYC
- referrals
- merchant services

7. TRANSACTIONS.

Transaction statuses may include:
- pending
- successful
- failed
- reversed
- cancelled

Always use the actual transaction record when available.

8. UNKNOWN QUESTIONS.

If the question cannot be answered accurately from the available
NATERPAY knowledge or tools, say:

"I cannot provide that information. Please contact the support team
or the founder, Nater Mbashau, for further assistance."

9. STYLE.

Be helpful, concise and professional.

Use Markdown where useful.

Do not expose internal tool names to users.

Do not mention that you are executing database functions.

Do not fabricate transaction references, balances, dates or amounts.
`;

/*
|--------------------------------------------------------------------------
| GEMINI TOOLS
|--------------------------------------------------------------------------
|
| These are declarations only.
| Gemini decides when one is needed.
| Our backend executes the actual functions.
|
*/

const tools = [
  {
    functionDeclarations: [
      {
        name: 'checkWallet',
        description:
          "Get the authenticated user's current available wallet balance, ledger balance and frozen status."
      },

      {
        name: 'getTransactions',
        description:
          "Get the authenticated user's most recent transactions."
      },

      {
        name: 'getTransaction',
        description:
          'Get one specific transaction using its provider reference.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            reference: {
              type: Type.STRING,
              description: 'The transaction/provider reference number.'
            }
          },
          required: ['reference']
        }
      },

      {
        name: 'getProfile',
        description:
          "Get the authenticated user's basic NATERPAY profile."
      },

      {
        name: 'getKYC',
        description:
          "Get the authenticated user's KYC verification status."
      },

      {
        name: 'getReferrals',
        description:
          "Get the authenticated user's referral information."
      },

      {
        name: 'checkBeneficiary',
        description:
          'Check whether a beneficiary belongs to the authenticated user.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            identifier: {
              type: Type.STRING,
              description: 'Phone, account number or beneficiary identifier.'
            }
          },
          required: ['identifier']
        }
      },

      {
        name: 'lookupVariation',
        description:
          'Explain that available service plans must be obtained from the NATERPAY service/VTpass backend.'
        ,
        parameters: {
          type: Type.OBJECT,
          properties: {
            service: {
              type: Type.STRING,
              description:
                'Service such as airtime, data, electricity or cable.'
            },
            network: {
              type: Type.STRING,
              description:
                'Network/provider where applicable.'
            }
          },
          required: ['service']
        }
      },

      {
        name: 'lookupMeter',
        description:
          'Prepare an electricity meter verification request. This function does not deduct money.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            disco: {
              type: Type.STRING
            },
            meterNumber: {
              type: Type.STRING
            }
          },
          required: ['disco', 'meterNumber']
        }
      },

      {
        name: 'buyAirtime',
        description:
          'Prepare an airtime purchase request. Never directly deduct money.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            network: {
              type: Type.STRING
            },
            amount: {
              type: Type.NUMBER
            },
            phone: {
              type: Type.STRING
            }
          },
          required: ['network', 'amount', 'phone']
        }
      },

      {
        name: 'buyData',
        description:
          'Prepare a data purchase request. Never directly deduct money.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            network: {
              type: Type.STRING
            },
            plan: {
              type: Type.STRING
            },
            phone: {
              type: Type.STRING
            }
          },
          required: ['network', 'plan', 'phone']
        }
      },

      {
        name: 'payElectricity',
        description:
          'Prepare an electricity payment request. Never directly deduct money.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            disco: {
              type: Type.STRING
            },
            meterNumber: {
              type: Type.STRING
            },
            amount: {
              type: Type.NUMBER
            }
          },
          required: ['disco', 'meterNumber', 'amount']
        }
      },

      {
        name: 'buyCable',
        description:
          'Prepare a cable subscription request. Never directly deduct money.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            provider: {
              type: Type.STRING
            },
            package: {
              type: Type.STRING
            }
          },
          required: ['provider', 'package']
        }
      },

      {
        name: 'buyEducationPin',
        description:
          'Prepare a WAEC or JAMB PIN purchase request. Never directly deduct money.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            exam: {
              type: Type.STRING
            }
          },
          required: ['exam']
        }
      }
    ]
  }
];

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function clean(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value.toObject === 'function') {
    return value.toObject();
  }

  return value;
}

function serialize(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_, v) => {
        if (v && typeof v === 'object' && v._bsontype === 'Decimal128') {
          return v.toString();
        }

        if (v instanceof Date) {
          return v.toISOString();
        }

        return v;
      })
    );
  } catch (err) {
    return value;
  }
}

async function saveChat(userId, role, message, actionTaken = null) {
  if (!AIChat) return;

  try {
    await AIChat.create({
      user: userId,
      role,
      message,
      actionTaken
    });
  } catch (error) {
    // Chat logging must NEVER crash the AI.
    console.error('[NATERPAY AI] Chat Logging Error:', error.message);
  }
}

/*
|--------------------------------------------------------------------------
| TOOL EXECUTION
|--------------------------------------------------------------------------
*/

async function executeTool(name, args, userId) {
  try {
    args = args || {};

    switch (name) {

      /*
      |--------------------------------------------------------------------------
      | WALLET
      |--------------------------------------------------------------------------
      */

      case 'checkWallet': {
        const wallet = await Wallet.findOne({ user: userId }).lean();

        if (!wallet) {
          return {
            found: false,
            message: 'No wallet record was found for this user.'
          };
        }

        return serialize({
          found: true,
          availableBalance: wallet.availableBalance ?? 0,
          ledgerBalance: wallet.ledgerBalance ?? 0,
          isFrozen: wallet.isFrozen ?? false
        });
      }

      /*
      |--------------------------------------------------------------------------
      | TRANSACTIONS
      |--------------------------------------------------------------------------
      */

      case 'getTransactions': {
        const transactions = await Transaction.find({
          user: userId
        })
          .sort({ createdAt: -1 })
          .limit(10)
          .select(
            'type amount status providerReference description createdAt'
          )
          .lean();

        return serialize({
          found: true,
          count: transactions.length,
          transactions
        });
      }

      /*
      |--------------------------------------------------------------------------
      | SINGLE TRANSACTION
      |--------------------------------------------------------------------------
      */

      case 'getTransaction': {
        if (!args.reference) {
          return {
            found: false,
            message: 'Transaction reference was not provided.'
          };
        }

        const transaction = await Transaction.findOne({
          user: userId,
          providerReference: String(args.reference).trim()
        })
          .select(
            'type amount status providerReference description createdAt'
          )
          .lean();

        if (!transaction) {
          return {
            found: false,
            message: 'No transaction with that reference was found.'
          };
        }

        return serialize({
          found: true,
          transaction
        });
      }

      /*
      |--------------------------------------------------------------------------
      | PROFILE
      |--------------------------------------------------------------------------
      */

      case 'getProfile': {
        const user = await User.findById(userId)
          .select('name email phone role isVerified createdAt')
          .lean();

        if (!user) {
          return {
            found: false,
            message: 'User profile was not found.'
          };
        }

        return serialize({
          found: true,
          profile: user
        });
      }

      /*
      |--------------------------------------------------------------------------
      | KYC
      |--------------------------------------------------------------------------
      */

      case 'getKYC': {

        if (!KYC) {
          return {
            available: false,
            message:
              'KYC model is not configured in this deployment. Please use the KYC section of NATERPAY.'
          };
        }

        const kyc = await KYC.findOne({
          user: userId
        }).lean();

        if (!kyc) {
          return {
            found: false,
            message: 'No KYC record was found.'
          };
        }

        return serialize({
          found: true,
          kyc
        });
      }

      /*
      |--------------------------------------------------------------------------
      | REFERRALS
      |--------------------------------------------------------------------------
      */

      case 'getReferrals': {

        if (!Referral) {
          return {
            available: false,
            message:
              'Referral model is not configured. Please use the Referral section of NATERPAY.'
          };
        }

        const referrals = await Referral.find({
          $or: [
            { user: userId },
            { referrer: userId },
            { referrerId: userId }
          ]
        })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();

        return serialize({
          found: true,
          count: referrals.length,
          referrals
        });
      }

      /*
      |--------------------------------------------------------------------------
      | BENEFICIARY
      |--------------------------------------------------------------------------
      */

      case 'checkBeneficiary': {

        if (!Beneficiary) {
          return {
            available: false,
            message:
              'Beneficiary model is not configured in this deployment.'
          };
        }

        if (!args.identifier) {
          return {
            found: false,
            message: 'Beneficiary identifier was not provided.'
          };
        }

        const beneficiary = await Beneficiary.findOne({
          user: userId,
          $or: [
            { phone: args.identifier },
            { accountNumber: args.identifier },
            { identifier: args.identifier }
          ]
        }).lean();

        return serialize({
          found: !!beneficiary,
          beneficiary: beneficiary || null
        });
      }

      /*
      |--------------------------------------------------------------------------
      | VARIATIONS
      |--------------------------------------------------------------------------
      */

      case 'lookupVariation': {
        return {
          available: false,
          service: args.service || null,
          network: args.network || null,
          message:
            'The actual service variation lookup should be performed through the NATERPAY VTpass/service integration. No financial transaction has been performed.'
        };
      }

      /*
      |--------------------------------------------------------------------------
      | METER
      |--------------------------------------------------------------------------
      */

      case 'lookupMeter': {
        return {
          status: 'prepared',
          disco: args.disco || null,
          meterNumber: args.meterNumber || null,
          message:
            'Meter verification must be completed through the NATERPAY electricity service using the configured VTpass integration. No money was deducted.'
        };
      }

      /*
      |--------------------------------------------------------------------------
      | FINANCIAL ACTIONS
      |--------------------------------------------------------------------------
      |
      | IMPORTANT:
      | These DO NOT perform financial transactions.
      |
      */

      case 'buyAirtime': {
        return {
          status: 'prepared',
          action: 'buyAirtime',
          network: args.network || null,
          amount: args.amount || null,
          phone: args.phone || null,
          message:
            'The airtime request has been understood, but AI does not directly deduct wallet funds. The user must complete the secure Airtime transaction flow in NATERPAY.'
        };
      }

      case 'buyData': {
        return {
          status: 'prepared',
          action: 'buyData',
          network: args.network || null,
          plan: args.plan || null,
          phone: args.phone || null,
          message:
            'The data request has been understood, but AI does not directly deduct wallet funds. The user must complete the secure Data transaction flow in NATERPAY.'
        };
      }

      case 'payElectricity': {
        return {
          status: 'prepared',
          action: 'payElectricity',
          disco: args.disco || null,
          meterNumber: args.meterNumber || null,
          amount: args.amount || null,
          message:
            'The electricity request has been understood, but AI does not directly deduct wallet funds. The user must complete the secure Electricity transaction flow in NATERPAY.'
        };
      }

      case 'buyCable': {
        return {
          status: 'prepared',
          action: 'buyCable',
          provider: args.provider || null,
          package: args.package || null,
          message:
            'The cable subscription request has been understood, but AI does not directly deduct wallet funds. The user must complete the secure Cable transaction flow in NATERPAY.'
        };
      }

      case 'buyEducationPin': {
        return {
          status: 'prepared',
          action: 'buyEducationPin',
          exam: args.exam || null,
          message:
            'The education PIN request has been understood, but AI does not directly deduct wallet funds. The user must complete the secure Education transaction flow in NATERPAY.'
        };
      }

      default:
        return {
          success: false,
          message: `Unknown tool: ${name}`
        };
    }

  } catch (error) {

    console.error(
      `[NATERPAY AI] Tool "${name}" Error:`,
      error
    );

    return {
      success: false,
      tool: name,
      error:
        'The requested NATERPAY information could not be retrieved at this time.'
    };
  }
}

/*
|--------------------------------------------------------------------------
| EXTRACT FUNCTION CALLS
|--------------------------------------------------------------------------
*/

function getFunctionCalls(response) {

  if (!response) {
    return [];
  }

  if (Array.isArray(response.functionCalls)) {
    return response.functionCalls;
  }

  if (typeof response.functionCalls === 'function') {
    try {
      const calls = response.functionCalls();
      return Array.isArray(calls) ? calls : [];
    } catch (err) {
      return [];
    }
  }

  const calls = [];

  const candidates = response.candidates || [];

  for (const candidate of candidates) {

    const parts = candidate?.content?.parts || [];

    for (const part of parts) {

      if (part.functionCall) {
        calls.push(part.functionCall);
      }
    }
  }

  return calls;
}

/*
|--------------------------------------------------------------------------
| EXTRACT TEXT
|--------------------------------------------------------------------------
*/

function getResponseText(response) {

  if (!response) {
    return '';
  }

  try {
    if (typeof response.text === 'string') {
      return response.text;
    }

    if (typeof response.text === 'function') {
      return response.text();
    }
  } catch (err) {
    // Ignore and use fallback extraction.
  }

  let text = '';

  for (const candidate of response.candidates || []) {

    for (const part of candidate?.content?.parts || []) {

      if (part.text) {
        text += part.text;
      }
    }
  }

  return text.trim();
}

/*
|--------------------------------------------------------------------------
| MAIN AI ROUTE
|--------------------------------------------------------------------------
*/

async function chatWithAI(request, reply) {

  try {

    /*
    |--------------------------------------------------------------------------
    | AUTH
    |--------------------------------------------------------------------------
    */

    if (!request.user || !request.user._id) {

      return reply.status(401).send({
        success: false,
        reply: 'Authentication is required.'
      });
    }

    const userId = request.user._id;

    /*
    |--------------------------------------------------------------------------
    | INPUT
    |--------------------------------------------------------------------------
    */

    const message =
      typeof request.body?.message === 'string'
        ? request.body.message.trim()
        : '';

    if (!message) {

      return reply.status(400).send({
        success: false,
        reply: 'Message is required.'
      });
    }

    if (message.length > 8000) {

      return reply.status(400).send({
        success: false,
        reply:
          'Your message is too long. Please shorten it and try again.'
      });
    }

    /*
    |--------------------------------------------------------------------------
    | API KEY
    |--------------------------------------------------------------------------
    */

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {

      console.error(
        '[NATERPAY AI] GEMINI_API_KEY is missing.'
      );

      return reply.status(503).send({
        success: false,
        reply:
          '⚠️ NATERPAY AI is temporarily unavailable. The AI service configuration is incomplete.'
      });
    }

    /*
    |--------------------------------------------------------------------------
    | SAVE USER MESSAGE
    |--------------------------------------------------------------------------
    */

    await saveChat(
      userId,
      'user',
      message
    );

    /*
    |--------------------------------------------------------------------------
    | GEMINI CLIENT
    |--------------------------------------------------------------------------
    */

    const ai = new GoogleGenAI({
      apiKey
    });

    /*
    |--------------------------------------------------------------------------
    | INITIAL REQUEST
    |--------------------------------------------------------------------------
    */

    let contents = [
      {
        role: 'user',
        parts: [
          {
            text: message
          }
        ]
      }
    ];

    /*
    |--------------------------------------------------------------------------
    | TOOL LOOP
    |--------------------------------------------------------------------------
    |
    | We allow several tool rounds.
    |
    | Example:
    |
    | User asks transaction question
    |       ↓
    | Gemini calls getTransaction
    |       ↓
    | Backend queries MongoDB
    |       ↓
    | Gemini receives result
    |       ↓
    | Gemini answers user
    |
    */

    const MAX_TOOL_ROUNDS = 5;

    let finalText = '';
    let lastAction = null;

    for (
      let round = 0;
      round < MAX_TOOL_ROUNDS;
      round++
    ) {

      const response =
        await ai.models.generateContent({

          model: MODEL,

          contents,

          config: {

            systemInstruction:
              SYSTEM_INSTRUCTION,

            tools,

            temperature: 0.2,

            maxOutputTokens: 4096
          }
        });

      /*
      |--------------------------------------------------------------------------
      | FUNCTION CALLS
      |--------------------------------------------------------------------------
      */

      const functionCalls =
        getFunctionCalls(response);

      /*
      |--------------------------------------------------------------------------
      | NORMAL TEXT RESPONSE
      |--------------------------------------------------------------------------
      */

      if (
        !functionCalls ||
        functionCalls.length === 0
      ) {

        finalText =
          getResponseText(response);

        break;
      }

      /*
      |--------------------------------------------------------------------------
      | IMPORTANT:
      | Preserve Gemini's function-call message.
      |--------------------------------------------------------------------------
      */

      if (
        response.candidates &&
        response.candidates[0] &&
        response.candidates[0].content
      ) {

        contents.push(
          response.candidates[0].content
        );

      } else {

        /*
        | Fallback representation.
        */

        contents.push({
          role: 'model',
          parts: functionCalls.map(call => ({
            functionCall: {
              name: call.name,
              args: call.args || {},
              id: call.id
            }
          }))
        });
      }

      /*
      |--------------------------------------------------------------------------
      | EXECUTE ALL FUNCTION CALLS
      |--------------------------------------------------------------------------
      */

      const functionResponseParts = [];

      for (const call of functionCalls) {

        if (!call || !call.name) {
          continue;
        }

        lastAction = call.name;

        const args =
          call.args ||
          call.arguments ||
          {};

        console.log(
          `[NATERPAY AI] Tool call: ${call.name}`,
          JSON.stringify(args)
        );

        const result =
          await executeTool(
            call.name,
            args,
            userId
          );

        /*
        |--------------------------------------------------------------------------
        | CURRENT GEMINI FUNCTION RESPONSE FORMAT
        |--------------------------------------------------------------------------
        */

        functionResponseParts.push({

          functionResponse: {

            name: call.name,

            response: {
              result: serialize(result)
            },

            ...(call.id
              ? { id: call.id }
              : {})
          }

        });
      }

      /*
      |--------------------------------------------------------------------------
      | SEND TOOL RESULTS BACK TO GEMINI
      |--------------------------------------------------------------------------
      */

      contents.push({

        role: 'user',

        parts: functionResponseParts

      });
    }

    /*
    |--------------------------------------------------------------------------
    | LOOP SAFETY
    |--------------------------------------------------------------------------
    */

    if (!finalText) {

      finalText =
        'I was unable to complete that request at the moment. Please try again.';
    }

    /*
    |--------------------------------------------------------------------------
    | SAVE AI RESPONSE
    |--------------------------------------------------------------------------
    */

    await saveChat(
      userId,
      'model',
      finalText,
      lastAction
    );

    /*
    |--------------------------------------------------------------------------
    | RESPONSE
    |--------------------------------------------------------------------------
    */

    return reply.send({

      success: true,

      reply: finalText

    });

  } catch (error) {

    /*
    |--------------------------------------------------------------------------
    | GLOBAL AI ERROR HANDLER
    |--------------------------------------------------------------------------
    */

    console.error(
      '[NATERPAY AI] Fatal Error:',
      error
    );

    const message =
      String(error?.message || '').toLowerCase();

    /*
    |--------------------------------------------------------------------------
    | QUOTA / RATE LIMIT
    |--------------------------------------------------------------------------
    */

    if (
      message.includes('429') ||
      message.includes('quota') ||
      message.includes('resource exhausted') ||
      message.includes('rate limit')
    ) {

      return reply.status(200).send({

        success: true,

        reply:
          '⏳ **NATERPAY AI is temporarily busy.** Please wait a little and try your question again.'
      });
    }

    /*
    |--------------------------------------------------------------------------
    | AUTHENTICATION
    |--------------------------------------------------------------------------
    */

    if (
      message.includes('401') ||
      message.includes('403') ||
      message.includes('api key') ||
      message.includes('permission_denied') ||
      message.includes('unregistered caller')
    ) {

      return reply.status(200).send({

        success: true,

        reply:
          '⚠️ **NATERPAY AI connection problem.** The Gemini API authentication or project configuration needs attention.'
      });
    }

    /*
    |--------------------------------------------------------------------------
    | MODEL ERROR
    |--------------------------------------------------------------------------
    */

    if (
      message.includes('model') &&
      (
        message.includes('not found') ||
        message.includes('unsupported') ||
        message.includes('invalid')
      )
    ) {

      return reply.status(200).send({

        success: true,

        reply:
          '⚠️ **NATERPAY AI model configuration problem.** Please verify the Gemini model configured for this deployment.'
      });
    }

    /*
    |--------------------------------------------------------------------------
    | GENERIC ERROR
    |--------------------------------------------------------------------------
    */

    return reply.status(200).send({

      success: true,

      reply:
        '⚠️ **NATERPAY AI temporarily encountered a connection problem.** Please try again shortly.'
    });
  }
}

/*
|--------------------------------------------------------------------------
| EXPORT
|--------------------------------------------------------------------------
*/

module.exports = {
  chatWithAI
};
