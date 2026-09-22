// src/utils/apiKeyTokens.ts
import { generateOpaqueToken, hashToken } from "./tokens";

const KEY_PREFIX = "lnk_";
// How much of the raw key is stored back for masked display (e.g.
// "lnk_a1b2c3d4...") — enough to tell keys apart in a list, never enough to
// reconstruct the secret.
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  rawKey: string;
  hash: string;
  prefix: string;
}

/** Generate a new API key. Only `hash` is ever persisted; `rawKey` is shown once. */
export function generateApiKey(): GeneratedApiKey {
  const rawKey = `${KEY_PREFIX}${generateOpaqueToken()}`;
  return {
    rawKey,
    hash: hashApiKey(rawKey),
    prefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/** SHA-256 hash of a raw API key, for lookup/comparison. */
export function hashApiKey(rawKey: string): string {
  return hashToken(rawKey);
}
