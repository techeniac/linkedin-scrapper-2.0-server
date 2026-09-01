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
// conversation this has already resolved.
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
  }

  console.log(`Done. ${done} resolved, ${failed} failed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
