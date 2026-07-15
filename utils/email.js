const { Resend } = require('resend');
require('dotenv').config();

// ============================================================================
// ULTRA-FAST HTTPS EMAIL CONFIGURATION
// ============================================================================
const resend = new Resend(process.env.RESEND_API_KEY);

// IMPORTANT: You must change this in your .env file to a real domain email 
// e.g., support@naterpay.com. Using onboarding@resend.dev WILL go to spam.
const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

const SITE_URL = process.env.APP_URL || 'https://naterpay-yrf7.onrender.com'; 

// ============================================================================
// INBOX-FRIENDLY HTML EMAIL TEMPLATE
// ============================================================================
function getEmailHTML(title, mainText, bigHighlightText) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 20px; background-color: #f4f4f4; font-family: Arial, sans-serif;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; margin: 0 auto; background-color: #050505; border-radius: 8px; overflow: hidden;">
            
            <!-- HEADER -->
            <tr>
                <td align="center" style="padding: 30px 20px; border-bottom: 2px solid #d4af37;">
                    <img src="${SITE_URL}/logopay.jpg.jpg" alt="NATER-PAY" style="width: 70px; height: 70px; border-radius: 50%; border: 2px solid #d4af37; margin-bottom: 15px; display: block;">
                    <h2 style="margin: 0; color: #d4af37; font-size: 20px; letter-spacing: 2px;">NATER-PAY</h2>
                </td>
            </tr>
            
            <!-- BODY -->
            <tr>
                <td align="center" style="padding: 40px 20px;">
                    <h3 style="color: #ffffff; margin-top: 0; margin-bottom: 15px; font-size: 18px; text-transform: uppercase;">${title}</h3>
                    
                    <p style="color: #cccccc; font-size: 14px; line-height: 1.6; margin-bottom: 30px;">
                        ${mainText}
                    </p>
                    
                    <!-- OTP BOX -->
                    <div style="background-color: #111111; border: 1px solid #d4af37; border-radius: 8px; padding: 20px; display: inline-block;">
                        <h1 style="margin: 0; font-size: 32px; letter-spacing: 8px; color: #d4af37;">${bigHighlightText}</h1>
                    </div>
                    
                    <p style="color: #888888; font-size: 12px; line-height: 1.5; margin-top: 30px;">
                        This code expires in 5 minutes.<br>
                        Our staff will never ask for your password.
                    </p>
                </td>
            </tr>
            
            <!-- FOOTER -->
            <tr>
                <td align="center" style="padding: 20px; background-color: #111111; border-top: 1px solid #222222;">
                    <p style="color: #666666; font-size: 10px; margin: 0; letter-spacing: 1px;">SECURED BY NATER-PAY INFRASTRUCTURES</p>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;
}

// ============================================================================
// EMAIL SENDING FUNCTIONS
// ============================================================================

async function sendOTPEmail(email, otp) {
    try {
        const { data, error } = await resend.emails.send({
            from: `"NATER-PAY" <${fromEmail}>`,
            to: email,
            subject: 'Account Verification Code',
            html: getEmailHTML(
                'Verification Required', 
                'You requested a code to access your NATER-PAY account. Please use the One-Time Password (OTP) below to grant access.',
                otp
            )
        });

        if (error) throw new Error(error.message);
        console.log(`[EMAIL] OTP sent to ${email} (ID: ${data.id})`);
    } catch (error) {
        console.error(`[EMAIL ERROR] Failed to send OTP to ${email}:`, error);
    }
}

async function sendPasswordResetEmail(email, otp) {
    try {
        const { data, error } = await resend.emails.send({
            from: `"NATER-PAY SUPPORT" <${fromEmail}>`,
            to: email,
            subject: 'Password Reset Request',
            html: getEmailHTML(
                'Security Reset', 
                'A request was made to reset the password for your NATER-PAY account. Use the secure code below to authorize the change.',
                otp
            )
        });

        if (error) throw new Error(error.message);
        console.log(`[EMAIL] Password reset OTP sent to ${email} (ID: ${data.id})`);
    } catch (error) {
        console.error(`[EMAIL ERROR] Failed to send Password Reset to ${email}:`, error);
    }
}

module.exports = {
    sendOTPEmail,
    sendPasswordResetEmail
};
