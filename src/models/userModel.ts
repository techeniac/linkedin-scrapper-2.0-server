import prisma from "../config/prisma";
import bcrypt from "bcryptjs";
import { User } from "../types";

// User model for database operations
export class UserModel {
  // Create a new user with hashed password
  static async create(
    email: string,
    password: string,
    name?: string,
  ): Promise<any> {
    const hashedPassword = await bcrypt.hash(password, 10);

    return prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Find user by email (includes password for authentication)
  static async findByEmail(email: string): Promise<any> {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Find user by ID (excludes password)
  static async findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Compare plain password with hashed password
  static async comparePassword(
    plainPassword: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  // Find user by email and return full record including hashed password
  // Used by the forgot-password flow to derive the per-user token secret.
  static async findByEmailWithPassword(email: string): Promise<any> {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Find user by ID and include the password hash (needed for token verification)
  static async findByIdWithPassword(id: string): Promise<any> {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        password: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Update a user's password (hashes the plain-text value before storing)
  static async updatePassword(id: string, plainPassword: string): Promise<void> {
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    await prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
    });
  }
}
