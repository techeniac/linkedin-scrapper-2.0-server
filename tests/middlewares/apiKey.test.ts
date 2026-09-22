jest.mock("../../src/config/prisma", () => ({
  __esModule: true,
  default: {
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import prisma from "../../src/config/prisma";
import { requireApiKey } from "../../src/middlewares/apiKey";
import { hashApiKey } from "../../src/utils/apiKeyTokens";

const mockedPrisma = prisma as unknown as {
  apiKey: { findUnique: jest.Mock; update: jest.Mock };
};

const buildReq = (headers: Record<string, string>) => ({ headers }) as any;
const res = {} as any;

describe("requireApiKey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.apiKey.update.mockResolvedValue({});
  });

  it("rejects a request with no x-api-key header", async () => {
    const next = jest.fn();
    await requireApiKey(buildReq({}), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects an unknown key", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue(null);
    const next = jest.fn();
    await requireApiKey(buildReq({ "x-api-key": "lnk_bad" }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects a revoked key", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      revokedAt: new Date(),
      expiresAt: null,
    });
    const next = jest.fn();
    await requireApiKey(buildReq({ "x-api-key": "lnk_revoked" }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects an expired key", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    const next = jest.fn();
    await requireApiKey(buildReq({ "x-api-key": "lnk_expired" }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("accepts a valid key, attaches apiKeyId, and touches lastUsedAt", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      revokedAt: null,
      expiresAt: null,
    });
    const req = buildReq({ "x-api-key": "lnk_good" });
    const next = jest.fn();
    await requireApiKey(req, res, next);
    expect(req.apiKeyId).toBe("k1");
    expect(next).toHaveBeenCalledWith();
    expect(mockedPrisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey("lnk_good") },
    });
  });
});
