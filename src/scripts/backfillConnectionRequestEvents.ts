// One-time backfill: connection_request_events was added on 2026-07-31, so
// every connection_requests row created before that date (and never
// re-touched since) has no matching event — the Connections report's chart
// (which reads the event log) misses that history even though the table
// (which reads connection_requests directly) shows it.
//
// This synthesizes the missing events from the CURRENT-STATE row itself:
//   - a SENT event (fromStatus=null -> toStatus=PENDING) at sentAt
//   - if the request has since resolved, a second event
//     (fromStatus=PENDING -> toStatus=<current status>) at resolvedAt
// both marked source=BACKFILL (an enum value already reserved for exactly
// this — see the ConnectionEventSource comment in schema.prisma) and
// occurredAtIsEstimate=true, since none of these timestamps were observed
// live.
//
// SAFE TO RE-RUN: a (userId, targetLinkedinId) pair is skipped entirely if
// it already has ANY row in connection_request_events — this script only
// ever fills a pair that has zero event history, so it can never duplicate
// or conflict with events written by the live trackSent/reconcile flow
// (ConnectionEventService), which is untouched by this script.
//
// Usage (run from backend/):
//   npx ts-node src/scripts/backfillConnectionRequestEvents.ts            # dry run — reports counts only
//   npx ts-node src/scripts/backfillConnectionRequestEvents.ts --apply    # actually writes the rows
import { ConnectionEventSource, ConnectionRequestStatus, Prisma } from "@prisma/client";
import prisma from "../config/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  const requests = await prisma.connectionRequest.findMany({
    select: {
      userId: true,
      targetLinkedinId: true,
      targetName: true,
      targetProfileUrl: true,
      actorLinkedinId: true,
      status: true,
      sentAt: true,
      resolvedAt: true,
    },
  });

  const existingEvents = await prisma.connectionRequestEvent.findMany({
    select: { userId: true, targetLinkedinId: true },
    distinct: ["userId", "targetLinkedinId"],
  });
  const tracked = new Set(existingEvents.map((e) => `${e.userId}:${e.targetLinkedinId}`));

  const toCreate: Prisma.ConnectionRequestEventUncheckedCreateInput[] = [];
  let skipped = 0;

  for (const r of requests) {
    const key = `${r.userId}:${r.targetLinkedinId}`;
    if (tracked.has(key)) {
      skipped++;
      continue; // already has real event history from the live flow — never touch
    }

    toCreate.push({
      userId: r.userId,
      targetLinkedinId: r.targetLinkedinId,
      targetName: r.targetName,
      targetProfileUrl: r.targetProfileUrl,
      actorLinkedinId: r.actorLinkedinId,
      fromStatus: null,
      toStatus: ConnectionRequestStatus.PENDING,
      occurredAt: r.sentAt,
      occurredAtIsEstimate: true,
      source: ConnectionEventSource.BACKFILL,
    });

    if (r.status !== ConnectionRequestStatus.PENDING && r.resolvedAt) {
      toCreate.push({
        userId: r.userId,
        targetLinkedinId: r.targetLinkedinId,
        targetName: r.targetName,
        targetProfileUrl: r.targetProfileUrl,
        actorLinkedinId: r.actorLinkedinId,
        fromStatus: ConnectionRequestStatus.PENDING,
        toStatus: r.status,
        occurredAt: r.resolvedAt,
        occurredAtIsEstimate: true,
        source: ConnectionEventSource.BACKFILL,
      });
    }
  }

  console.log(
    `${requests.length} connection_requests scanned — ${skipped} pairs already tracked (skipped), ` +
      `${toCreate.length} backfill events ${APPLY ? "will be inserted" : "would be inserted (dry run)"}.`,
  );

  if (!APPLY) {
    console.log("Re-run with --apply to write these rows.");
    return;
  }
  if (toCreate.length === 0) return;

  const BATCH = 500;
  for (let i = 0; i < toCreate.length; i += BATCH) {
    await prisma.connectionRequestEvent.createMany({ data: toCreate.slice(i, i + BATCH) });
  }
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
