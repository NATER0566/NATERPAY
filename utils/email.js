const { Resend } = require('resend');

// Initialize Resend with your API key from the .env file
const resend = new Resend(process.env.RESEND_API_KEY);

// Use your verified domain email here, or Resend's testing email
const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev'; 

/**
 * Send Registration OTP
 */
async function sendOTPEmail(email, otp) {
  try {
    const { data, error } = await resend.emails.send({
      from: `NATERPAY <${fromEmail}>`,
      to: email,
      subject: 'NATERPAY - Your Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Welcome to NATERPAY!</h2>
          <p>Your email verification code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
          <p>Please enter this code on the verification page to activate your account.</p>
          <p>If you didn't request this, please ignore this email.</p>
        </div>
      `
    });

    if (error) {
      throw new Error(error.message);
    }
    console.log(`OTP Email sent to ${email} (ID: ${data.id})`);
  } catch (error) {
    console.error('Resend OTP Email Error:', error);
  }
}

/**
 * Send Password Reset OTP
 */
async function sendPasswordResetEmail(email, otp) {
  try {
    const { data, error } = await resend.emails.send({
      from: `NATERPAY Support <${fromEmail}>`,
      to: email,
      subject: 'NATERPAY - Password Reset Request',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Password Reset Request</h2>
          <p>We received a request to reset your NATERPAY password. Your reset code is:</p>
          <h1 style="color: #E53935; letter-spacing: 5px;">${otp}</h1>
          <p>This code will expire shortly. Do not share this code with anyone.</p>
          <p>If you didn't request a password reset, please secure your account immediately.</p>
        </div>
      `
    });

    if (error) {
      throw new Error(error.message);
    }
    console.log(`Password Reset Email sent to ${email} (ID: ${data.id})`);
  } catch (error) {
    console.error('Resend Password Reset Error:', error);
  }
}

module.exports = {
  sendOTPEmail,
  sendPasswordResetEmail
};
