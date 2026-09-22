// src/services/apiKeyService.ts
import prisma from "../config/prisma";
import { generateApiKey } from "../utils/apiKeyTokens";

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export class ApiKeyService {
  /** Issue a new key. Only its hash is stored; the raw value is returned once. */
  static async issue(name: string): Promise<{ id: string; rawKey: string }> {
    const { rawKey, hash, prefix } = generateApiKey();
    const record = await prisma.apiKey.create({
      data: { name, keyHash: hash, keyPrefix: prefix },
    });
    return { id: record.id, rawKey };
  }

  static async list(): Promise<ApiKeySummary[]> {
    return prisma.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        revokedAt: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  /** Idempotent: revoking an already-revoked key is a no-op. */
  static async revoke(id: string): Promise<void> {
    await prisma.apiKey.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
