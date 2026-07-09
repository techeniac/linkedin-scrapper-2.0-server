// src/services/mailService.ts
import nodemailer, { Transporter } from "nodemailer";
import {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  NODE_ENV,
  RESET_CODE_TTL_MINUTES,
} from "../config/env";
import logger from "../utils/logger";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // TLS on 465, STARTTLS otherwise
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

/**
 * Send a password-reset OTP to the user's email. When SMTP isn't configured we
 * don't throw — the caller must not leak whether an account exists — but in
 * non-production we log the code so the flow is testable locally.
 */
export async function sendPasswordResetCode(
  email: string,
  code: string,
): Promise<void> {
  const tx = getTransporter();

  if (!tx) {
    logger.warn("SMTP not configured; skipping password-reset email");
    if (NODE_ENV !== "production") {
      logger.info(`[DEV] Password reset code for ${email}: ${code}`);
    }
    return;
  }

  try {
    await tx.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: "Your password reset code",
      text: `Your password reset code is ${code}. It expires in ${RESET_CODE_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.`,
      html: `<p>Your password reset code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p><p>It expires in ${RESET_CODE_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>`,
    });
  } catch (err: any) {
    // Log but don't surface — the endpoint always responds the same way.
    logger.error("Failed to send password-reset email", {
      error: err?.message,
    });
  }
}
