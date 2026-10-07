// src/scripts/dedupeMessageEvents.ts
//
// ONE-TIME CLEANUP, run before Task 12 relaxes message_events' unique
// constraint from (userId, conversationKey, messageId) to (conversationKey,
// messageId). Existing data can already contain duplicate rows for the same
// (conversationKey, messageId) under different userIds — the exact bug this
// whole feature fixes (a shared LinkedIn account scraped by more than one
// Techeniac user). The new, narrower unique index cannot be created while
// those duplicates exist, so this merges each duplicate group down to one
// row using the SAME field-merge rules MessageEventRepository.upsertEvents
// already applies on conflict (see messageEventService.ts's class-level
// comment for the full reasoning per field):
//   isFirstTouch / isFirstReply : AND
//   isFollowUp                  : OR
//   respondsToAt                : GREATEST (ignoring NULLs)
//   selfTimeZone / participantLinkedinId / selfLinkedinId / text : COALESCE,
//     preferring the survivor's own (non-null) value, falling back to any
//     duplicate's value
// occurredAt/type are immutable and identical across the group by definition
// (they come from the messageId itself), so no merge decision is needed for
// them. The row with the earliest createdAt is kept (arbitrary but
// deterministic); the rest are deleted.
//
// Usage (run from backend/):
//   npx ts-node src/scripts/dedupeMessageEvents.ts            # dry run — reports counts only
//   npx ts-node src/scripts/dedupeMessageEvents.ts --apply    # actually merges and deletes
import prisma from "../config/prisma";

const APPLY = process.argv.includes("--apply");

interface DupeRow {
  id: string;
  userId: string;
  conversationKey: string;
  messageId: string;
  isFirstTouch: boolean;
  isFollowUp: boolean;
  isFirstReply: boolean;
  respondsToAt: Date | null;
  selfTimeZone: string | null;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
  text: string | null;
  createdAt: Date;
}

async function main() {
  const dupeKeys = await prisma.$queryRaw<Array<{ conversation_key: string; message_id: string }>>`
    SELECT conversation_key, message_id
    FROM message_events
    GROUP BY conversation_key, message_id
    HAVING COUNT(*) > 1
  `;

  console.log(`${dupeKeys.length} duplicate (conversationKey, messageId) groups found.`);
  if (dupeKeys.length === 0) return;

  let merged = 0;
  let deleted = 0;

  for (const { conversation_key, message_id } of dupeKeys) {
    const rows = await prisma.messageEvent.findMany({
      where: { conversationKey: conversation_key, messageId: message_id },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length < 2) continue;

    const [survivor, ...rest] = rows as unknown as DupeRow[];
    const merged_ = rest.reduce(
      (acc, r) => ({
        isFirstTouch: acc.isFirstTouch && r.isFirstTouch,
        isFirstReply: acc.isFirstReply && r.isFirstReply,
        isFollowUp: acc.isFollowUp || r.isFollowUp,
        respondsToAt:
          acc.respondsToAt && r.respondsToAt
            ? acc.respondsToAt > r.respondsToAt
              ? acc.respondsToAt
              : r.respondsToAt
            : (acc.respondsToAt ?? r.respondsToAt),
        selfTimeZone: acc.selfTimeZone ?? r.selfTimeZone,
        participantLinkedinId: acc.participantLinkedinId ?? r.participantLinkedinId,
        selfLinkedinId: acc.selfLinkedinId ?? r.selfLinkedinId,
        text: acc.text ?? r.text,
      }),
      {
        isFirstTouch: survivor.isFirstTouch,
        isFirstReply: survivor.isFirstReply,
        isFollowUp: survivor.isFollowUp,
        respondsToAt: survivor.respondsToAt,
        selfTimeZone: survivor.selfTimeZone,
        participantLinkedinId: survivor.participantLinkedinId,
        selfLinkedinId: survivor.selfLinkedinId,
        text: survivor.text,
      },
    );

    console.log(
      `${APPLY ? "Merging" : "Would merge"} ${rows.length} rows for (${conversation_key}, ${message_id}) → keep ${survivor.id}, delete [${rest.map((r) => r.id).join(", ")}]`,
    );
    merged += 1;
    deleted += rest.length;

    if (!APPLY) continue;

    await prisma.$transaction([
      prisma.messageEvent.update({ where: { id: survivor.id }, data: merged_ }),
      prisma.messageEvent.deleteMany({ where: { id: { in: rest.map((r) => r.id) } } }),
    ]);
  }

  console.log(
    `${merged} groups ${APPLY ? "merged" : "would be merged"}, ${deleted} duplicate rows ${APPLY ? "deleted" : "would be deleted"}.`,
  );
  if (!APPLY) console.log("Re-run with --apply to perform the merge.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
