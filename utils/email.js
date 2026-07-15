const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

// ============================================================================
// EMAIL SERVER CONFIGURATION (Using Resend SMTP for flawless CID delivery)
// ============================================================================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.resend.com',
    port: process.env.SMTP_PORT || 465,
    secure: true,
    auth: {
        // If you are using Resend, the username is always 'resend'
        user: process.env.SMTP_USER || 'resend', 
        // Uses your Resend API key as the password
        pass: process.env.SMTP_PASS || process.env.RESEND_API_KEY 
    }
});

const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

// ============================================================================
// NATER-PAY HTML EMAIL TEMPLATE (DARK MODE, GOLD & ANIMATED)
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
            
            /* These animations will run on Apple Mail and clients that support modern CSS */
            @keyframes pumping {
                0% { transform: scale(1); }
                50% { transform: scale(1.05); }
                100% { transform: scale(1); }
            }
            @keyframes refractive-glow {
                0% { box-shadow: 0 0 10px rgba(212, 175, 55, 0.4); }
                50% { box-shadow: 0 0 25px rgba(255, 255, 255, 0.6), 0 0 15px rgba(212, 175, 55, 0.8); }
                100% { box-shadow: 0 0 10px rgba(212, 175, 55, 0.4); }
            }
            .animated-logo {
                width: 140px; 
                height: auto; 
                border-radius: 16px; 
                border: 2px solid #d4af37;
                animation: pumping 2.5s infinite ease-in-out, refractive-glow 3.5s infinite ease-in-out;
            }
        </style>
    </head>
    <body style="margin: 0; padding: 20px; background-color: #050505; font-family: 'Montserrat', Arial, sans-serif;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #111111; border: 1.5px solid #d4af37; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.9);">
            
            <tr>
                <td align="center" style="padding: 30px 20px 15px 20px; background-color: #0a0a0a;">
                    <h2 style="margin: 0; color: #d4af37; font-family: 'Cinzel', serif; font-weight: 900; letter-spacing: 3px; font-size: 24px;">NATER-PAY</h2>
                    <p style="margin: 5px 0 0 0; color: #888; font-size: 10px; letter-spacing: 2px; text-transform: uppercase;">Enterprise Terminal</p>
                </td>
            </tr>
            
            <tr>
                <td align="center" style="padding: 15px 20px 30px 20px; background-color: #0a0a0a; border-bottom: 2px solid #d4af37;">
                    <img src="cid:naterpay_logo" alt="NATER-PAY LOGO" class="animated-logo" style="width: 140px; border-radius: 16px; border: 2px solid #d4af37; box-shadow: 0 0 15px rgba(212, 175, 55, 0.5);">
                </td>
            </tr>
            
            <tr>
                <td align="center" style="padding: 40px 30px;">
                    <h3 style="color: #ffffff; margin-top: 0; margin-bottom: 20px; font-weight: 800; text-transform: uppercase; font-size: 18px;">${title}</h3>
                    
                    <p style="color: #cccccc; font-size: 14px; line-height: 1.6; margin-bottom: 35px; font-weight: 500;">
                        ${mainText}
                    </p>
                    
                    <div style="background: linear-gradient(145deg, rgba(212, 175, 55, 0.1) 0%, rgba(0,0,0,0.8) 100%); border: 1.5px dashed #d4af37; border-radius: 16px; padding: 25px 40px; display: inline-block; box-shadow: inset 0 0 20px rgba(0,0,0,0.5);">
                        <h1 style="margin: 0; font-size: 42px; letter-spacing: 8px; color: #d4af37; font-weight: 900; text-shadow: 0 2px 4px rgba(0,0,0,0.8);">${bigHighlightText}</h1>
                    </div>
                    
                    <p style="color: #666666; font-size: 12px; line-height: 1.5; margin-top: 35px; font-weight: 600;">
                        <span style="color: #d32f2f;">SECURITY ALERT:</span> This code expires in 5 minutes.<br>
                        Naterpay staff will <strong style="color: #fff;">never</strong> ask for your password or OTP.
                    </p>
                </td>
            </tr>
            
            <tr>
                <td align="center" style="padding: 20px; background-color: #050505; border-top: 1px solid #222;">
                    <p style="color: #555555; font-size: 10px; margin: 0; font-weight: 800; letter-spacing: 1.5px;">v3.0 SECURED BY NATER-PAY INFRASTRUCTURES PROTOCOL</p>
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
        const mailOptions = {
            from: `"NATER-PAY SECURE" <${fromEmail}>`,
            to: email,
            subject: 'NATER-PAY | Account Verification',
            html: getEmailHTML(
                'Authorization Required', 
                'You requested a verification code to authenticate your NATER-PAY terminal. Please use the One-Time Password (OTP) below to grant access.',
                otp
            ),
            attachments: [{
                filename: 'logopay.jpg.jpg',
                path: path.join(__dirname, '../public/logopay.jpg.jpg'), 
                cid: 'naterpay_logo' 
            }]
        };

        await transporter.sendMail(mailOptions);
        console.log(`[EMAIL] OTP sent successfully to ${email}`);
    } catch (error) {
        console.error(`[EMAIL ERROR] Failed to send OTP to ${email}:`, error);
    }
}

async function sendPasswordResetEmail(email, otp) {
    try {
        const mailOptions = {
            from: `"NATER-PAY SUPPORT" <${fromEmail}>`,
            to: email,
            subject: 'NATER-PAY | Password Reset Request',
            html: getEmailHTML(
                'Vault Override Request', 
                'A request was made to override and reset the security password for your NATER-PAY terminal. Use the secure code below to authorize the change.',
                otp
            ),
            attachments: [{
                filename: 'logopay.jpg.jpg',
                path: path.join(__dirname, '../public/logopay.jpg.jpg'), 
                cid: 'naterpay_logo' 
            }]
        };

        await transporter.sendMail(mailOptions);
        console.log(`[EMAIL] Password reset OTP sent successfully to ${email}`);
    } catch (error) {
        console.error(`[EMAIL ERROR] Failed to send Password Reset to ${email}:`, error);
    }
}

module.exports = {
    sendOTPEmail,
    sendPasswordResetEmail
};
