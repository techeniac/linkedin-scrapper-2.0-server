// One-time backfill: message_events (added 2026-08-03) only captures message
// activity the extension observed live going forward. message_activity holds
// LIFETIME aggregate counts per conversation reconstructed from LinkedIn's
// full scraped history (in this DB, as far back as 2019) — so the Messages
// report's chart (event log) misses almost all of that history even though
// its table (message_activity) shows it.
//
// This synthesizes APPROXIMATE per-message events from each conversation's
// aggregate counts, spread evenly across [firstMessageAt, lastMessageAt]:
//   - `sentCount` synthetic SENT events; the earliest is marked isFirstTouch
//     (matches "fresh"), and up to `followUpCount` of the rest are marked
//     isFollowUp (matches "followups") — order among them is arbitrary since
//     there's no way to know which specific sends were true re-pings.
//   - `receivedCount` synthetic RECEIVED events; if hasReply, the earliest is
//     marked isFirstReply (matches "replied").
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never sets respondsToAt. The Late
// Messages / Missed Follow-Up reports both require respondsToAt to identify
// which message answered which — that causal link genuinely cannot be
// reconstructed from aggregate counts, and guessing would risk fabricating
// false "late" flags. So this backfill improves the Messages dashboard's
// chart, but intentionally contributes nothing to Late Messages / Missed
// Follow-Up — those stay accurate-but-empty for pre-tracking history rather
// than plausible-but-wrong.
//
// SAFE TO RE-RUN: a (userId, conversationKey) pair is skipped entirely if it
// already has ANY row in message_events — this script only ever fills a
// conversation with zero event history, so it can never duplicate or
// conflict with events written by the live recordEvents flow
// (MessageEventService), which is untouched by this script. Conversations
// missing firstMessageAt/lastMessageAt are skipped (no basis to place events
// in time) rather than guessed at.
//
// Usage (run from backend/):
//   npx ts-node src/scripts/backfillMessageEvents.ts            # dry run — reports counts only
//   npx ts-node src/scripts/backfillMessageEvents.ts --apply    # actually writes the rows
import { randomUUID } from "crypto";
import prisma from "../config/prisma";

const APPLY = process.argv.includes("--apply");

// Evenly spaces `count` timestamps across [from, to] inclusive (count=1 lands on `from`).
const spread = (from: Date, to: Date, count: number): Date[] => {
  if (count <= 0) return [];
  if (count === 1 || to.getTime() <= from.getTime()) return [from];
  const span = to.getTime() - from.getTime();
  return Array.from({ length: count }, (_, i) => new Date(from.getTime() + (span * i) / (count - 1)));
};

interface EventRow {
  id: string;
  userId: string;
  conversationKey: string;
  messageId: string;
  type: "SENT" | "RECEIVED";
  occurredAt: Date;
  isFirstTouch: boolean;
  isFollowUp: boolean;
  isFirstReply: boolean;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
}

async function main() {
  const conversations = await prisma.messageActivity.findMany({
    select: {
      userId: true,
      conversationKey: true,
      participantLinkedinId: true,
      selfLinkedinId: true,
      sentCount: true,
      receivedCount: true,
      followUpCount: true,
      hasReply: true,
      firstMessageAt: true,
      lastMessageAt: true,
    },
  });

  const existingEvents = await prisma.messageEvent.findMany({
    select: { userId: true, conversationKey: true },
    distinct: ["userId", "conversationKey"],
  });
  const tracked = new Set(existingEvents.map((e) => `${e.userId}:${e.conversationKey}`));

  const toCreate: EventRow[] = [];
  let skippedTracked = 0;
  let skippedNoDates = 0;

  for (const c of conversations) {
    const key = `${c.userId}:${c.conversationKey}`;
    if (tracked.has(key)) {
      skippedTracked++;
      continue; // already has real event history from the live flow — never touch
    }
    if (!c.firstMessageAt || !c.lastMessageAt) {
      skippedNoDates++;
      continue; // no basis to place synthetic events in time
    }

    const sentTimes = spread(c.firstMessageAt, c.lastMessageAt, c.sentCount);
    sentTimes.forEach((occurredAt, i) => {
      toCreate.push({
        id: randomUUID(),
        userId: c.userId,
        conversationKey: c.conversationKey,
        messageId: `backfill:sent:${i}`,
        type: "SENT",
        occurredAt,
        isFirstTouch: i === 0,
        isFollowUp: i > 0 && i <= c.followUpCount,
        isFirstReply: false,
        participantLinkedinId: c.participantLinkedinId,
        selfLinkedinId: c.selfLinkedinId,
      });
    });

    const receivedTimes = spread(c.firstMessageAt, c.lastMessageAt, c.receivedCount);
    receivedTimes.forEach((occurredAt, i) => {
      toCreate.push({
        id: randomUUID(),
        userId: c.userId,
        conversationKey: c.conversationKey,
        messageId: `backfill:received:${i}`,
        type: "RECEIVED",
        occurredAt,
        isFirstTouch: false,
        isFollowUp: false,
        isFirstReply: i === 0 && c.hasReply,
        participantLinkedinId: c.participantLinkedinId,
        selfLinkedinId: c.selfLinkedinId,
      });
    });
  }

  console.log(
    `${conversations.length} message_activity rows scanned — ${skippedTracked} already tracked, ` +
      `${skippedNoDates} missing first/last message dates (skipped), ` +
      `${toCreate.length} backfill events ${APPLY ? "will be inserted" : "would be inserted (dry run)"}.`,
  );

  if (!APPLY) {
    console.log("Re-run with --apply to write these rows.");
    return;
  }
  if (toCreate.length === 0) return;

  const BATCH = 500;
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const batch = toCreate.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map(
        (r) => prisma.$executeRaw`
          INSERT INTO message_events (
            id, user_id, conversation_key, message_id, type, occurred_at,
            is_first_touch, is_follow_up, is_first_reply, responds_to_at,
            self_time_zone, participant_linkedin_id, self_linkedin_id, created_at
          ) VALUES (
            ${r.id}, ${r.userId}, ${r.conversationKey}, ${r.messageId},
            ${r.type}::"MessageEventType", ${r.occurredAt},
            ${r.isFirstTouch}, ${r.isFollowUp}, ${r.isFirstReply}, NULL,
            NULL, ${r.participantLinkedinId}, ${r.selfLinkedinId}, NOW()
          )
          ON CONFLICT (user_id, conversation_key, message_id) DO NOTHING
        `,
      ),
    );
  }
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
