import crypto from "crypto";
import { generateApiKey, hashApiKey } from "../../src/utils/apiKeyTokens";

describe("apiKeyTokens", () => {
  it("generates a key with the lnk_ prefix and a matching SHA-256 hash", () => {
    const { rawKey, hash, prefix } = generateApiKey();
    expect(rawKey.startsWith("lnk_")).toBe(true);
    expect(hash).toBe(crypto.createHash("sha256").update(rawKey).digest("hex"));
    expect(prefix).toBe(rawKey.slice(0, 12));
  });

  it("generates a different key on every call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.rawKey).not.toBe(b.rawKey);
  });

  it("hashApiKey is deterministic for the same input", () => {
    const raw = "lnk_test";
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });
});
