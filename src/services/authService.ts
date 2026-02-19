import jwt, { SignOptions } from "jsonwebtoken";
import { UserModel } from "../models/userModel";
import { JWT_SECRET, JWT_EXPIRES_IN } from "../config/env";
import { AuthResponse, LoginRequest, RegisterRequest } from "../types";

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
}
