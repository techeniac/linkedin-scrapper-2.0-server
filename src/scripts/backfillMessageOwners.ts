// src/scripts/backfillMessageOwners.ts
//
// ONE-TIME BACKFILL: resolves the HubSpot owner for every conversationKey
// that already has message_events history (predating this feature), using
// the exact same resolution logic the live path uses (MessageOwnerResolverService)
// — so historical report data switches to real-owner attribution too,
// instead of staying stuck on scraper-based attribution forever. Safe to
// re-run: MessageOwnerResolverService itself is idempotent (a
// conversation_owner_cache hit short-circuits to reusing the cached value,
// see that file), so re-running this only re-stamps message_events rows
// with whatever's already cached — it never re-queries HubSpot for a
// conversation this has already GENUINELY resolved (including a real "no
// owner" fact). A conversation whose last attempt hit a TRANSIENT failure
// (not HubSpot-connected, rate limit, network blip) is deliberately left
// uncached, so a re-run retries HubSpot for those instead of being stuck —
// this is what makes re-running this script the recovery path after a
// partial run gets rate-limited.
//
// Run this AFTER Task 12's constraint migration, so a conversation's message
// rows are no longer duplicated per scraper — an unresolved backfill run
// against un-deduped data would work, but at up to N-times the necessary
// resolution work for an N-scraper conversation.
//
// Usage (run from backend/):
//   npx ts-node src/scripts/backfillMessageOwners.ts
import prisma from "../config/prisma";
import { MessageOwnerResolverService } from "../services/messageOwnerResolverService";

async function main() {
  const conversations = await prisma.messageEvent.findMany({
    select: { conversationKey: true, userId: true },
    // Deterministic: the EARLIEST recorded scraper for each conversationKey
    // is consistently used (and thus whose HubSpot token the lookup runs
    // under) — without this, distinct() picks an arbitrary row per group.
    // The first person to touch a conversation is a reasonable default;
    // more likely to still be relevant/connected than a random later one.
    orderBy: { createdAt: "asc" },
    distinct: ["conversationKey"],
  });

  console.log(`${conversations.length} distinct conversations to resolve.`);

  let done = 0;
  let failed = 0;
  for (const c of conversations) {
    try {
      await MessageOwnerResolverService.resolveAndPersist({
        conversationKey: c.conversationKey,
        scraperUserId: c.userId,
      });
      done += 1;
    } catch (err: any) {
      failed += 1;
      console.error(`Failed to resolve ${c.conversationKey}: ${err?.message}`);
    }
    if (done % 50 === 0) console.log(`${done}/${conversations.length} resolved...`);
    // Small delay between iterations to avoid bursting past HubSpot's rate
    // limit — 250ms ≈ 4 req/s, comfortably under HubSpot's ~10 req/s
    // sustained limit for this kind of endpoint.
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`Done. ${done} resolved, ${failed} failed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
