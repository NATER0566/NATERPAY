const { Resend } = require('resend');
require('dotenv').config();

// ============================================================================
// ULTRA-FAST HTTPS EMAIL CONFIGURATION
// ============================================================================
const resend = new Resend(process.env.RESEND_API_KEY);
const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

// THE FIX: Using your live Render URL to fetch the image from your public folder
const SITE_URL = process.env.APP_URL || 'https://naterpay-yrf7.onrender.com'; 

// ============================================================================
// NATER-PAY HTML EMAIL TEMPLATE (DARK MODE, GOLD)
// ============================================================================
function getEmailHTML(title, mainText, bigHighlightText) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Montserrat:wght@400;600;800&display=swap');
        </style>
    </head>
    <body style="margin: 0; padding: 20px; background-color: #050505; font-family: 'Montserrat', Arial, sans-serif;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; margin: 0 auto; background-color: #111111; border: 1px solid #d4af37; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
            
            <tr>
                <td align="center" style="padding: 25px 20px; background-color: #0a0a0a; border-bottom: 1.5px solid #d4af37;">
                    <img src="${SITE_URL}/logopay.jpg.jpg" alt="NATER-PAY" style="width: 70px; height: 70px; object-fit: cover; border-radius: 50%; border: 2px solid #d4af37; margin-bottom: 12px; box-shadow: 0 0 10px rgba(212, 175, 55, 0.3);">
                    <h3 style="margin: 0; color: #d4af37; font-family: 'Cinzel', serif; font-weight: 800; letter-spacing: 2px; font-size: 15px;">NATER-PAY</h3>
                </td>
            </tr>
            
            <tr>
                <td align="center" style="padding: 35px 25px;">
                    <h4 style="color: #ffffff; margin-top: 0; margin-bottom: 15px; font-weight: 700; text-transform: uppercase; font-size: 16px;">${title}</h4>
                    
                    <p style="color: #cccccc; font-size: 13px; line-height: 1.6; margin-bottom: 30px; font-weight: 500;">
                        ${mainText}
                    </p>
                    
                    <div style="background: linear-gradient(145deg, rgba(212, 175, 55, 0.1) 0%, rgba(0,0,0,0.8) 100%); border: 1px dashed #d4af37; border-radius: 12px; padding: 20px 35px; display: inline-block;">
                        <h1 style="margin: 0; font-size: 36px; letter-spacing: 8px; color: #d4af37; font-weight: 900;">${bigHighlightText}</h1>
                    </div>
                    
                    <p style="color: #666666; font-size: 11px; line-height: 1.5; margin-top: 30px; font-weight: 600;">
                        <span style="color: #d32f2f;">SECURITY ALERT:</span> This code expires in 5 minutes.<br>
                        Naterpay staff will <strong style="color: #fff;">never</strong> ask for your password.
                    </p>
                </td>
            </tr>
            
            <tr>
                <td align="center" style="padding: 15px; background-color: #050505; border-top: 1px solid #222;">
                    <p style="color: #555555; font-size: 9px; margin: 0; font-weight: 800; letter-spacing: 1px;">v3.0 SECURED BY NATER-PAY INFRASTRUCTURES</p>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;
}

// ============================================================================
// LIGHTNING-FAST EMAIL SENDING
// ============================================================================

async function sendOTPEmail(email, otp) {
    try {
        const { data, error } = await resend.emails.send({
            from: `"NATER-PAY SECURE" <${fromEmail}>`,
            to: email,
            subject: 'NATER-PAY | Account Verification',
            html: getEmailHTML(
                'Authorization Required', 
                'You requested a verification code to authenticate your NATER-PAY terminal. Please use the One-Time Password (OTP) below to grant access.',
                otp
            )
        });

        if (error) throw new Error(error.message);
        console.log(`[EMAIL] OTP sent instantly to ${email} (ID: ${data.id})`);
    } catch (error) {
        console.error(`[EMAIL ERROR] Failed to send OTP to ${email}:`, error);
    }
}

async function sendPasswordResetEmail(email, otp) {
    try {
        const { data, error } = await resend.emails.send({
            from: `"NATER-PAY SUPPORT" <${fromEmail}>`,
            to: email,
            subject: 'NATER-PAY | Password Reset Request',
            html: getEmailHTML(
                'Vault Override Request', 
                'A request was made to override and reset the security password for your NATER-PAY terminal. Use the secure code below to authorize the change.',
                otp
            )
        });

        if (error) throw new Error(error.message);
        console.log(`[EMAIL] Password reset OTP sent instantly to ${email} (ID: ${data.id})`);
    } catch (error) {
        console.error(`[EMAIL ERROR] Failed to send Password Reset to ${email}:`, error);
    }
}

module.exports = {
    sendOTPEmail,
    sendPasswordResetEmail
};
