import { Request } from "express";

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  errors?: any;
}

export interface HealthData {
  status: string;
  timestamp: string;
  uptime: number;
  environment: string;
}

export interface User {
  id: string;
  email: string;
  password?: string;
  name?: string | null;
  hubspotAccessToken?: string | null;
  hubspotRefreshToken?: string | null;
  hubspotOwnerId?: string | null;
  hubspotTokenExpiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthRequest extends Request {
  user?: User;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}
