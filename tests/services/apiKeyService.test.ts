jest.mock("../../src/config/prisma", () => ({
  __esModule: true,
  default: {
    apiKey: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import prisma from "../../src/config/prisma";
import { ApiKeyService } from "../../src/services/apiKeyService";

const mockedPrisma = prisma as unknown as {
  apiKey: {
    create: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
};

describe("ApiKeyService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("issue() stores only the hash and returns the raw key once", async () => {
    mockedPrisma.apiKey.create.mockResolvedValue({ id: "key-1" });

    const result = await ApiKeyService.issue("Next.js server");

    expect(result.id).toBe("key-1");
    expect(result.rawKey.startsWith("lnk_")).toBe(true);
    const createArgs = mockedPrisma.apiKey.create.mock.calls[0][0];
    expect(createArgs.data.name).toBe("Next.js server");
    expect(createArgs.data.keyHash).not.toBe(result.rawKey);
    expect(createArgs.data.keyPrefix).toBe(result.rawKey.slice(0, 12));
  });

  it("list() returns masked summaries ordered by creation date", async () => {
    mockedPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        name: "A",
        keyPrefix: "lnk_aaaa",
        revokedAt: null,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
    ]);

    const result = await ApiKeyService.list();

    expect(result).toHaveLength(1);
    expect(mockedPrisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });

  it("revoke() sets revokedAt only on a currently-active key", async () => {
    mockedPrisma.apiKey.updateMany.mockResolvedValue({ count: 1 });

    await ApiKeyService.revoke("key-1");

    expect(mockedPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: "key-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
