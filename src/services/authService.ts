import jwt, { SignOptions } from "jsonwebtoken";
import { UserModel } from "../models/userModel";
import prisma from "../config/prisma";
import {
  JWT_SECRET,
  ACCESS_TOKEN_TTL,
  RESET_CODE_TTL_MINUTES,
  RESET_CODE_MAX_ATTEMPTS,
} from "../config/env";
import {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
} from "../types";
import { AppError, UnauthorizedError } from "../errors/AppError";
import { TokenService } from "./tokenService";
import { hashToken, generateResetCode } from "../utils/tokens";
import { sendPasswordResetCode } from "./mailService";

// Authentication service: registration, login, token refresh, password reset.
export class AuthService {
  // Generate a short-lived access token (JWT) for an authenticated user.
  static generateAccessToken(userId: string): string {
    return jwt.sign({ userId, type: "access" }, JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_TTL,
    } as SignOptions);
  }

  // Backwards-compatible alias.
  static generateToken(userId: string): string {
    return this.generateAccessToken(userId);
  }

  // Verify and decode an access token; validates the payload shape.
  static verifyToken(token: string): { userId: string } {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string" || !decoded || !(decoded as any).userId) {
      throw new Error("Invalid token payload");
    }
    return decoded as { userId: string };
  }

  // Register a new user; returns the user (with access token) + refresh token.
  static async register(data: RegisterRequest): Promise<AuthResponse> {
    const existingUser = await UserModel.findByEmail(data.email);
    if (existingUser) {
      throw new AppError("User already exists", 409);
    }

    const user = await UserModel.create(data.email, data.password, data.name);
    const token = this.generateAccessToken(user.id);
    const refreshToken = await TokenService.issueRefreshToken(user.id);

    const { password, ...userWithoutPassword } = user;
    return { user: { ...userWithoutPassword, token }, refreshToken };
  }

  // Authenticate a user; returns the user (with access token) + refresh token.
  static async login(data: LoginRequest): Promise<AuthResponse> {
    const user = await UserModel.findByEmail(data.email);
    if (!user) {
      throw new UnauthorizedError("Invalid credentials");
    }

    const isValidPassword = await UserModel.comparePassword(
      data.password,
      user.password!,
    );
    if (!isValidPassword) {
      throw new UnauthorizedError("Invalid credentials");
    }

    const token = this.generateAccessToken(user.id);
    const refreshToken = await TokenService.issueRefreshToken(user.id);

    const { password, ...userWithoutPassword } = user;
    return { user: { ...userWithoutPassword, token }, refreshToken };
  }

  // Exchange a refresh token for a new access token + rotated refresh token.
  static async refresh(
    rawRefreshToken: string,
  ): Promise<{ token: string; refreshToken: string }> {
    const { userId, refreshToken } =
      await TokenService.rotateRefreshToken(rawRefreshToken);
    const token = this.generateAccessToken(userId);
    return { token, refreshToken };
  }

  // Revoke a refresh token (logout). Never throws.
  static async logout(rawRefreshToken?: string): Promise<void> {
    if (rawRefreshToken) {
      await TokenService.revokeRefreshToken(rawRefreshToken);
    }
  }

  // Issue a password-reset OTP. Per product requirement this validates that the
  // account exists first and returns 404 for unknown emails (a deliberate
  // UX-vs-account-enumeration tradeoff; the strict authLimiter throttles abuse).
  static async requestPasswordReset(email: string): Promise<void> {
    const user = await UserModel.findByEmail(email);
    if (!user) {
      throw new AppError(
        `We couldn't find an account for ${email}. Please check the email and try again.`,
        404,
      );
    }

    // Invalidate any outstanding unused codes so only the newest is valid.
    await prisma.passwordResetCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const code = generateResetCode();
    await prisma.passwordResetCode.create({
      data: {
        codeHash: hashToken(code),
        userId: user.id,
        expiresAt: new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000),
      },
    });

    await sendPasswordResetCode(user.email, code);
  }

  // Verify an OTP and set a new password. On success, revokes all refresh
  // tokens so every existing session is forced to re-authenticate.
  static async resetPassword(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    const user = await UserModel.findByEmail(email);
    if (!user) {
      throw new AppError("Invalid or expired code", 400);
    }

    const record = await prisma.passwordResetCode.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!record) {
      throw new AppError("Invalid or expired code", 400);
    }

    // Lock out after too many wrong attempts.
    if (record.attempts >= RESET_CODE_MAX_ATTEMPTS) {
      await prisma.passwordResetCode.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
      throw new AppError(
        "Too many attempts. Please request a new code.",
        400,
      );
    }

    const isMatch = record.codeHash === hashToken(code);
    if (!isMatch) {
      await prisma.passwordResetCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new AppError("Invalid or expired code", 400);
    }

    // Success: update password, consume the code, revoke all sessions.
    await UserModel.updatePassword(user.id, newPassword);
    await prisma.passwordResetCode.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await TokenService.revokeAllForUser(user.id);
  }
}
