// src/scripts/backfillAmbiguousReasons.ts
//
// ONE-TIME BACKFILL, run after the 2026-10-08 owner-override ambiguous-reason
// feature shipped: re-resolves every conversation that is either (a) already
// cached as 'ambiguous' with no reason recorded (resolved by the old code,
// before conversation_owner_cache.ambiguous_reason existed), or (b) never
// resolved at all (no cache row — typically because no scraper ever captured
// a participant name for it, the NO_NAME case).
//
// This is a DELIBERATE REVERSAL of that feature's spec Non-Goal ("No
// backfill for already-ambiguous conversations") — confirmed explicitly by
// the user. For case (a), MessageOwnerResolverService.resolveAndPersist is
// normally idempotent BECAUSE a cache hit short-circuits before ever
// re-checking HubSpot (see that file) — the only way to force a genuine
// re-resolution is to delete the stale cache row first, which this script
// does only for rows with attribution_source = 'ambiguous'. It NEVER
// touches a 'manual' row (a human's override decision must stay sticky
// forever, per that same file's design) or a 'hubspot' row (already
// correctly resolved; re-querying HubSpot for it is unnecessary and risks
// flipping the owner if HubSpot data has since changed, which isn't this
// backfill's purpose).
//
// Case (b) needs no cache-row deletion — resolveAndPersist's own cache-miss
// path already does the genuine resolution; this script only needs to find
// those conversationKeys and give the resolver a scraperUserId to run under
// (same earliest-message_events-row convention as backfillMessageOwners.ts).
//
// Usage (run from backend/):
//   npx ts-node --transpile-only src/scripts/backfillAmbiguousReasons.ts
import prisma from "../config/prisma";
import { MessageOwnerResolverService } from "../services/messageOwnerResolverService";

async function main() {
  const ambiguous = await prisma.conversationOwnerCache.findMany({
    where: { attributionSource: "ambiguous" },
    select: { conversationKey: true },
  });
  const noName = await prisma.$queryRaw<Array<{ conversationKey: string }>>`
    SELECT conversation_key AS "conversationKey" FROM message_activity
    GROUP BY conversation_key HAVING COUNT(participant_name) = 0
  `;
  const targetKeys = [...new Set([...ambiguous.map((a) => a.conversationKey), ...noName.map((n) => n.conversationKey)])];

  console.log(`${targetKeys.length} target conversations (${ambiguous.length} already-ambiguous, ${noName.length} never-named).`);

  // Force a cache miss only for the already-ambiguous rows — see file header.
  const deleted = await prisma.conversationOwnerCache.deleteMany({
    where: { conversationKey: { in: ambiguous.map((a) => a.conversationKey) }, attributionSource: "ambiguous" },
  });
  console.log(`Cleared ${deleted.count} stale 'ambiguous' cache rows to force genuine re-resolution.`);

  let done = 0;
  let failed = 0;
  for (const conversationKey of targetKeys) {
    const earliestEvent = await prisma.messageEvent.findFirst({
      where: { conversationKey },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });
    if (!earliestEvent) {
      console.error(`Skipping ${conversationKey}: no message_events row to derive a scraperUserId from.`);
      failed += 1;
      continue;
    }
    try {
      await MessageOwnerResolverService.resolveAndPersist({
        conversationKey,
        scraperUserId: earliestEvent.userId,
      });
      done += 1;
    } catch (err: any) {
      failed += 1;
      console.error(`Failed to resolve ${conversationKey}: ${err?.message}`);
    }
    if (done % 50 === 0) console.log(`${done}/${targetKeys.length} resolved...`);
    // Same rate-limit cushion as backfillMessageOwners.ts — 250ms ≈ 4 req/s.
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`Done. ${done} resolved, ${failed} failed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
