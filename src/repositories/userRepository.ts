// src/repositories/userRepository.ts
import prisma from "../config/prisma";

export class UserRepository {
  static findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }

  static async updateHubSpotTokens(
    userId: string,
    data: {
      accessToken: string;
      refreshToken: string;
      ownerId: string | null;
      expiresAt: Date;
    },
  ) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        hubspotAccessToken: data.accessToken,
        hubspotRefreshToken: data.refreshToken,
        hubspotOwnerId: data.ownerId,
        hubspotTokenExpiresAt: data.expiresAt,
      },
    });
  }

  static async clearHubSpotTokens(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        hubspotAccessToken: null,
        hubspotRefreshToken: null,
        hubspotOwnerId: null,
        hubspotTokenExpiresAt: null,
      },
    });
  }
}
