import { Request } from "express";

// Standard API response structure
export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  errors?: any;
}

// Health check response data
export interface HealthData {
  status: string;
  timestamp: string;
}

// User entity with optional HubSpot OAuth fields
export interface User {
  id: string;
  email: string;
  password?: string;
  name?: string | null;
  hubspotAccessToken?: string | null;
  hubspotRefreshToken?: string | null;
  hubspotOwnerId?: string | null;
  hubspotTokenExpiresAt?: Date | null;
  token?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Extended request with authenticated user
export interface AuthRequest extends Request {
  user?: User;
}

// Request shape for the /api/public/* router once requireApiKey and
// resolveRequesterScope have run. scopeOwnerIds is null for an unrestricted
// requester (x-scope: all) and undefined only if resolveRequesterScope
// hasn't run yet — publicController.ts's applyRequesterScope treats
// undefined as "deny everything" (fail-closed), not "allow everything".
export interface PublicApiRequest extends Request {
  apiKeyId?: string;
  requesterOwnerId?: string;
  scopeOwnerIds?: string[] | null;
}

// Login request payload
export interface LoginRequest {
  email: string;
  password: string;
}

// Registration request payload
export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

// Authentication response with user (incl. access token) and refresh token
export interface AuthResponse {
  user: User;
  refreshToken?: string;
}

// Refresh access token request payload
export interface RefreshRequest {
  refreshToken: string;
}

// Forgot-password request payload
export interface ForgotPasswordRequest {
  email: string;
}

// Reset-password request payload (OTP flow)
export interface ResetPasswordRequest {
  email: string;
  code: string;
  password: string;
}

export * from "./hubspot.types";
