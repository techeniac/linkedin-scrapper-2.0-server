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
  uptime: number;
  environment: string;
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

// Authentication response with user and token
export interface AuthResponse {
  user: User;
}

export * from "./hubspot.types";
