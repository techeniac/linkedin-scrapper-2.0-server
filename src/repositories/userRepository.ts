import prisma from "../config/prisma";

export class UserRepository {
  static findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        hubspotAccessToken: true,
        hubspotRefreshToken: true,
        hubspotOwnerId: true,
        hubspotTokenExpiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
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
}
