import jwt, { SignOptions } from "jsonwebtoken";
import { UserModel } from "../models/userModel";
import { JWT_SECRET, JWT_EXPIRES_IN, APP_URL } from "../config/env";
import { AuthResponse, LoginRequest, RegisterRequest } from "../types";
import { sendMail, buildPasswordResetEmail } from "./emailService";

// Authentication service for user registration and login
export class AuthService {
  // Generate JWT token for authenticated user
  static generateToken(userId: string): string {
    return jwt.sign({ userId }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    } as SignOptions);
  }

  // Verify and decode JWT token
  static verifyToken(token: string): any {
    return jwt.verify(token, JWT_SECRET);
  }

  // Register new user and return JWT token
  static async register(data: RegisterRequest): Promise<AuthResponse> {
    const existingUser = await UserModel.findByEmail(data.email);
    if (existingUser) {
      throw new Error("User already exists");
    }

    const user = await UserModel.create(data.email, data.password, data.name);
    const token = this.generateToken(user.id);

    const { password, ...userWithoutPassword } = user;
    return { user: { ...userWithoutPassword, token } };
  }

  // Authenticate user and return JWT token
  static async login(data: LoginRequest): Promise<AuthResponse> {
    const user = await UserModel.findByEmail(data.email);
    if (!user) {
      throw new Error("Invalid credentials");
    }

    const isValidPassword = await UserModel.comparePassword(
      data.password,
      user.password!,
    );
    if (!isValidPassword) {
      throw new Error("Invalid credentials");
    }

    const token = this.generateToken(user.id);

    const { password, ...userWithoutPassword } = user;
    return { user: { ...userWithoutPassword, token } };
  }

  // ─── Forgot-password flow ────────────────────────────────────────────────────

  // Derive a per-user reset-token secret from the global JWT_SECRET and the
  // user's current bcrypt password hash.  When the password is changed the hash
  // changes → old tokens signed with the previous secret are permanently invalid.
  private static resetTokenSecret(passwordHash: string): string {
    return `${JWT_SECRET}:${passwordHash}`;
  }

  // Generate a 15-minute reset token signed with the derived secret.
  static generateResetToken(userId: string, passwordHash: string): string {
    return jwt.sign({ userId, purpose: "password-reset" }, this.resetTokenSecret(passwordHash), {
      expiresIn: "15m",
    } as SignOptions);
  }

  // Verify a reset token.  Returns the userId on success, throws on failure.
  static verifyResetToken(token: string, passwordHash: string): string {
    const payload = jwt.verify(token, this.resetTokenSecret(passwordHash)) as any;
    if (payload.purpose !== "password-reset") {
      throw new Error("Invalid token purpose");
    }
    return payload.userId as string;
  }

  // Initiate a password reset: always resolves (no email enumeration).
  // Sends an email only when the address is found.
  static async forgotPassword(email: string): Promise<void> {
    const user = await UserModel.findByEmailWithPassword(email);
    if (!user || !user.password) {
      // Silently return — do not reveal whether the email exists.
      return;
    }

    const resetToken = this.generateResetToken(user.id, user.password);
    // The reset link carries the token as a query param so the extension popup
    // (or any hosted page) can extract it and show the confirm-reset form.
    const resetUrl = `${APP_URL}?reset_token=${encodeURIComponent(resetToken)}`;
    const { html, text } = buildPasswordResetEmail(resetUrl, 15);

    // Fire-and-forget inside a try/catch so SMTP errors do not leak status.
    try {
      await sendMail({
        to: user.email,
        subject: "Reset your HubLead password",
        html,
        text,
      });
    } catch {
      // intentionally swallowed — caller always sees 200
    }
  }

  // Complete a password reset using the signed token.
  // The token's own expiry and the secret-rotation mechanism enforce single-use.
  static async resetPassword(token: string, newPassword: string): Promise<void> {
    // Step 1: decode without verification to extract userId (safe — we verify next)
    let userId: string;
    try {
      const decoded = jwt.decode(token) as any;
      if (!decoded?.userId || decoded?.purpose !== "password-reset") {
        throw new Error("Invalid token");
      }
      userId = decoded.userId as string;
    } catch {
      throw new Error("Invalid or malformed token");
    }

    // Step 2: fetch user with current password hash to reconstruct secret
    const user = await UserModel.findByIdWithPassword(userId);
    if (!user || !user.password) {
      throw new Error("Invalid token");
    }

    // Step 3: verify signature + expiry using the derived secret
    try {
      this.verifyResetToken(token, user.password);
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        throw new Error("Reset link has expired. Please request a new one.");
      }
      throw new Error("Invalid or already-used reset token");
    }

    // Step 4: update the password — this changes the hash, rotating the secret
    // and permanently invalidating the just-used token (and any duplicates).
    await UserModel.updatePassword(userId, newPassword);
  }
}
