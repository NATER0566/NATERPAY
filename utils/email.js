const { Resend } = require('resend');
require('dotenv').config();

// [1] STRUCTURED LOGGING ENGINE
let logger;
try { 
    logger = require('pino')(); 
} catch (e) { 
    logger = { 
        info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message: msg, ...meta })),
        error: (msg, err, meta = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: msg, error: err?.message || err, ...meta }))
    };
}

const resend = new Resend(process.env.RESEND_API_KEY);
const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

// [2] TEXT SANITIZATION (XSS Protection for Email Clients)
const sanitizeText = (str) => str ? String(str).replace(/[<>]/g, '').trim() : '';

// [3] EXTERNAL API RETRY ENGINE (Network Resilience)
async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); 
        }
    }
}

// ============================================================================
// ULTRA-PREMIUM, TEXT-ONLY HTML EMAIL TEMPLATE (SPAM-PROOF & SANITIZED)
// ============================================================================
function getEmailHTML(title, mainText, bigHighlightText) {
    const safeTitle = sanitizeText(title);
    const safeMainText = sanitizeText(mainText);
    const safeHighlight = sanitizeText(bigHighlightText);

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Montserrat:wght@400;600;800&display=swap');
        </style>
    </head>
    <body style="margin: 0; padding: 20px; background-color: #050505; font-family: 'Montserrat', Arial, sans-serif;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; margin: 0 auto; background-color: #0a0a0a; border: 2px solid #d4af37; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.9);">
            
            <!-- PREMIUM TYPOGRAPHY HEADER -->
            <tr>
                <td align="center" style="padding: 35px 20px; border-bottom: 1.5px solid #d4af37; background: linear-gradient(180deg, #111111 0%, #0a0a0a 100%);">
                    <h1 style="margin: 0; color: #d4af37; font-family: 'Cinzel', serif; font-weight: 900; letter-spacing: 6px; font-size: 28px; text-shadow: 0 2px 10px rgba(212, 175, 55, 0.2);">NATER-PAY</h1>
                    <p style="margin: 8px 0 0 0; color: #888888; font-size: 10px; letter-spacing: 4px; text-transform: uppercase; font-weight: 600;">Enterprise Terminal Core</p>
                </td>
            </tr>
            
            <!-- BODY -->
            <tr>
                <td align="center" style="padding: 40px 25px;">
                    <h3 style="color: #ffffff; margin-top: 0; margin-bottom: 20px; font-weight: 800; text-transform: uppercase; font-size: 16px; letter-spacing: 1px;">${safeTitle}</h3>
                    
                    <p style="color: #cccccc; font-size: 14px; line-height: 1.7; margin-bottom: 35px; font-weight: 500;">
                        ${safeMainText}
                    </p>
                    
                    <!-- HIGH-VISIBILITY COPYABLE OTP CARD -->
                    <div style="background-color: #000000; border: 1px dashed #d4af37; border-radius: 12px; padding: 25px; width: 85%; margin: 0 auto; box-shadow: inset 0 0 20px rgba(212, 175, 55, 0.05);">
                        <p style="color: #d4af37; font-size: 10px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 2px; font-weight: 700;">Secure Auth Code</p>
                        
                        <h1 style="margin: 0; font-size: 42px; letter-spacing: 12px; color: #ffffff; font-weight: 900; user-select: all; -webkit-user-select: all; cursor: pointer;">
                            ${safeHighlight} <span style="font-size: 22px; color: #d4af37; vertical-align: middle; margin-left: -5px; user-select: none;">&#128203;</span>
                        </h1>
                        
                        <p style="color: #666666; font-size: 11px; margin: 15px 0 0 0; font-weight: 600;">(Long-press or double-tap the code to copy)</p>
                    </div>
                    
                    <p style="color: #888888; font-size: 11px; line-height: 1.6; margin-top: 40px; font-weight: 600;">
                        <span style="color: #d32f2f;">SECURITY ALERT:</span> This code expires in 5 minutes.<br>
                        Our staff will <strong style="color: #ffffff;">never</strong> ask for your password or OTP.
                    </p>
                </td>
            </tr>
            
            <!-- FOOTER -->
            <tr>
                <td align="center" style="padding: 20px; background-color: #050505; border-top: 1px solid #1a1a1a;">
                    <p style="color: #444444; font-size: 9px; margin: 0; font-weight: 800; letter-spacing: 1.5px;">v3.0 SECURED BY NATER-PAY PROTOCOL</p>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;
}

// ============================================================================
// EMAIL SENDING FUNCTIONS (FAULT TOLERANT)
// ============================================================================

async function sendOTPEmail(email, otp) {
    const safeEmail = sanitizeText(email);
    try {
        await withRetry(() => resend.emails.send({
            from: `"NATER-PAY" <${fromEmail}>`,
            to: safeEmail,
            subject: 'Action Required: Verification Code',
            html: getEmailHTML(
                'Authorization Required', 
                'You requested a verification code to authenticate your session. Please copy the One-Time Password (OTP) below to proceed.',
                otp
            )
        }));
        logger.info(`[EMAIL] OTP sent successfully to ${safeEmail}`);
        return true;
    } catch (error) {
        logger.error(`[EMAIL ERROR] Failed to send OTP to ${safeEmail}`, error);
        throw new Error('Email gateway failed to deliver the verification code.');
    }
}

async function sendPasswordResetEmail(email, otp) {
    const safeEmail = sanitizeText(email);
    try {
        await withRetry(() => resend.emails.send({
            from: `"NATER-PAY SECURITY" <${fromEmail}>`,
            to: safeEmail,
            subject: 'Action Required: Password Reset',
            html: getEmailHTML(
                'Vault Override Request', 
                'A request was made to override your account security. Copy the secure code below to authorize the password reset.',
                otp
            )
        }));
        logger.info(`[EMAIL] Password reset OTP sent to ${safeEmail}`);
        return true;
    } catch (error) {
        logger.error(`[EMAIL ERROR] Failed to send Password Reset to ${safeEmail}`, error);
        throw new Error('Email gateway failed to deliver the password reset code.');
    }
}

module.exports = {
    sendOTPEmail,
    sendPasswordResetEmail
};
