import nodemailer from "nodemailer";
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } from "../config/env";
import logger from "../utils/logger";

// Lazy-initialised transporter — created once on first use so the server boots
// even when SMTP credentials are not yet set.
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return transporter;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendMail(opts: SendMailOptions): Promise<void> {
  const transport = getTransporter();
  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? opts.html.replace(/<[^>]+>/g, ""),
    });
    logger.info(`Email sent to ${opts.to} — subject: "${opts.subject}"`);
  } catch (err) {
    // Log but do NOT expose SMTP errors to callers — they surface as a generic
    // "if the address exists you'll receive an email" message.
    logger.error("Failed to send email", { to: opts.to, err });
    throw err;
  }
}

export function buildPasswordResetEmail(resetUrl: string, expiresMinutes = 15): { html: string; text: string } {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your HubLead password</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; margin: 0; padding: 40px 0; }
    .container { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 24px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 24px; }
    .body { padding: 32px 24px; }
    .body p { color: #4a5568; line-height: 1.6; margin: 0 0 16px; }
    .btn { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; }
    .footer { padding: 16px 24px; text-align: center; color: #a0aec0; font-size: 12px; border-top: 1px solid #e2e8f0; }
    .token-box { background: #f5f7fa; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; font-family: monospace; font-size: 13px; word-break: break-all; color: #2d3748; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>HubLead</h1>
    </div>
    <div class="body">
      <p>You requested a password reset. Click the button below to set a new password. The link expires in <strong>${expiresMinutes} minutes</strong>.</p>
      <p style="text-align:center;"><a href="${resetUrl}" class="btn">Reset Password</a></p>
      <p>Or copy this link into your browser:</p>
      <div class="token-box">${resetUrl}</div>
      <p style="color:#718096;font-size:13px;">If you did not request a password reset, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} HubLead. This email was sent automatically — please do not reply.
    </div>
  </div>
</body>
</html>`;

  const text = `Reset your HubLead password\n\nClick the link below (expires in ${expiresMinutes} minutes):\n\n${resetUrl}\n\nIf you did not request a password reset, ignore this email.`;

  return { html, text };
}
