import { ContactListItem } from "../types/hubspot.types";

interface CacheEntry {
  contacts: ContactListItem[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

export function getCachedContacts(ownerId: string): ContactListItem[] | null {
  const entry = cache.get(ownerId);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(ownerId);
    return null;
  }
  return entry.contacts;
}

export function setCachedContacts(ownerId: string, contacts: ContactListItem[]): void {
  cache.set(ownerId, { contacts, expiresAt: Date.now() + TTL_MS });
}
