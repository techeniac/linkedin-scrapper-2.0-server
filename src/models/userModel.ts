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

  // Update a user's password (hashes the new plaintext password)
  static async updatePassword(
    userId: string,
    newPassword: string,
  ): Promise<void> {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
  }

}
