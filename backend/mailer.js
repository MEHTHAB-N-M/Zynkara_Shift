const nodemailer = require('nodemailer');

/**
 * Check whether SMTP credentials are fully provided in environment variables.
 */
function isSmtpConfigured() {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

/**
 * Build a Nodemailer transport using current environment configuration.
 */
function getTransporter() {
  if (!isSmtpConfigured()) {
    return null;
  }

  const host = process.env.SMTP_HOST.trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER.trim();
  const pass = process.env.SMTP_PASS.trim();

  return nodemailer.createTransport({
    host: host,
    port: port,
    secure: port === 465, // true for port 465 (SSL), false for other ports (TLS/STARTTLS)
    auth: {
      user: user,
      pass: pass,
    },
  });
}

/**
 * Send a verification email containing a 6-digit OTP code.
 * Fails closed if SMTP is not configured or if transmission fails.
 * @param {string} email
 * @param {string} code
 */
async function sendVerificationEmail(email, code) {
  if (!isSmtpConfigured()) {
    const err = new Error("Email verification is not currently configured. Please contact the administrator.");
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const transporter = getTransporter();
  const smtpFrom = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@zynkarashift.local';

  const mailOptions = {
    from: `"ZynkaraShift" <${smtpFrom}>`,
    to: email,
    subject: 'Verify Your Email - ZynkaraShift',
    html: `
      <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e8ed; border-radius: 12px; background-color: #ffffff;">
        <h2 style="color: #4f46e5; font-size: 24px; font-weight: 700; margin-bottom: 20px; text-align: center;">Verify Your ZynkaraShift Account</h2>
        <p style="font-size: 16px; color: #374151; line-height: 1.5;">Thank you for registering on ZynkaraShift PaaS Platform. Please use the verification code below to complete your registration:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="display: inline-block; font-family: monospace; font-size: 32px; font-weight: 700; color: #1e1b4b; background-color: #f3f4f6; padding: 12px 24px; border-radius: 8px; letter-spacing: 4px;">${code}</span>
        </div>
        <p style="font-size: 14px; color: #6b7280; line-height: 1.5; text-align: center; margin-top: 30px;">This code is valid for 15 minutes. If you did not request this code, please ignore this email.</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[MAILER] Sent verification email to ${email}`);
  } catch (err) {
    console.error(`[MAILER] Failed to deliver verification email to ${email}:`, err);
    const deliveryErr = new Error("Failed to deliver verification email. Please check the email address or contact the administrator.");
    deliveryErr.code = 'SMTP_DELIVERY_FAILED';
    throw deliveryErr;
  }
}

module.exports = {
  isSmtpConfigured,
  sendVerificationEmail
};
