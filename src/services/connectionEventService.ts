// src/services/connectionEventService.ts
import {
  ConnectionEventSource,
  ConnectionRequestStatus,
  Prisma,
} from "@prisma/client";
import prisma from "../config/prisma";
import { LINKEDIN_INVITE_EXPIRY_MONTHS } from "../config/env";

/**
 * Append-only history of connection-request status transitions.
 *
 * WHY THIS EXISTS
 * `connection_requests` holds one row per (user, target) and a re-send re-opens
 * that row — overwriting the previous outcome. LinkedIn expires invitations
 * after ~6 months and explicitly allows re-inviting afterwards, so at real
 * volume a rep WILL re-invite contacts whose invitations expired, and each such
 * re-send silently destroys an expiry that a report needed to count.
 *
 * So: snapshot questions ("how many are pending right now") read the
 * current-state table; historical questions ("how many expired in March") read
 * these events. Rows here are never updated or deleted.
 *
 * EVERY status write must go through ConnectionEventService.applyTransition so
 * an event can't be forgotten — the state change and its event are written in
 * one transaction.
 */

// LinkedIn expires sent invitations after ~6 months — see config/env.ts for
// the full reasoning and validation.

export interface TransitionInput {
  userId: string;
  targetLinkedinId: string;
  toStatus: ConnectionRequestStatus;
  source: ConnectionEventSource;
  /** When it actually happened. Defaults to now when genuinely unknown. */
  occurredAt?: Date | null;
  /** True when occurredAt is inferred rather than observed. */
  occurredAtIsEstimate?: boolean;
  // Optional identity details to record on the event and refresh on the row.
  targetName?: string | null;
  targetProfileUrl?: string | null;
  actorLinkedinId?: string | null;
  actorName?: string | null;
  actorPublicIdentifier?: string | null;
  /** Only used for SENT transitions that create/re-open a row. */
  sentAtIsEstimate?: boolean;
}

/**
 * Best-known expiry moment for an invitation that has left the Sent list
 * without being accepted or withdrawn.
 *
 * LinkedIn never tells us when an invitation expired, so this is always an
 * estimate. If the invitation is old enough to have aged out, its expiry date
 * is `sentAt + window` — a real date, and far better than "whenever the sync
 * happened to run". If it vanished sooner than the window it was almost
 * certainly declined, and we have no signal at all for when; fall back to the
 * detection time.
 */
export const addMonthsClamped = (from: Date, months: number): Date => {
  const d = new Date(from);
  const day = d.getDate();
  d.setDate(1); // avoid overflow while the month is being changed
  d.setMonth(d.getMonth() + months);
  // Clamp to the last valid day of the target month. Without this, JS overflows
  // (31 Aug + 6mo → "31 Feb" → 3 Mar), quietly drifting month-end invitations
  // into the wrong reporting bucket.
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
};

export const estimateExpiryDate = (sentAt: Date, detectedAt: Date): Date => {
  const aged = addMonthsClamped(sentAt, LINKEDIN_INVITE_EXPIRY_MONTHS);
  return aged <= detectedAt ? aged : detectedAt;
};

// Shared by applyTransition and recordSent below — see the CONCURRENCY note
// on applyTransition for why the defaults (2s connection-wait / 5s run) are
// too tight here: a transaction that deliberately waits on a row lock needs
// more room than one that never expects to block.
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 10_000 };

export class ConnectionEventService {
  /**
   * Record a transition: write the event and move the current-state row, in one
   * transaction.
   *
   * `expectedFrom` guards against out-of-order signals — pass the status(es) the
   * row must currently be in for the write to apply. A late "accepted" must not
   * be able to undo a "withdrawn", and a reconcile must never re-resolve an
   * already-terminal row. When the guard doesn't match, nothing is written and
   * NO event is emitted (there was no transition).
   *
   * CONCURRENCY: the read-and-check happens via `SELECT ... FOR UPDATE`, which
   * takes a row lock inside this transaction. A concurrent call racing on the
   * SAME (userId, targetLinkedinId) — e.g. two open LinkedIn tabs both
   * reconciling around the same moment — blocks on that lock until this
   * transaction commits, then re-reads the ALREADY-UPDATED row and correctly
   * finds its status no longer matches `expectedFrom`. Without the lock, both
   * calls could read the row before either writes, both pass the guard, and
   * both write — recording the same transition twice.
   *
   * Returns true when the transition actually applied.
   *
   * TRANSACTION TIMEOUTS: Prisma's defaults (2s to acquire a connection, 5s to
   * run) are sized for transactions that never expect to block. This one, by
   * design, sometimes DOES block — a concurrent racer waits on the FOR UPDATE
   * lock above until the winner commits. Verified live: two genuinely
   * concurrent calls on the same row hit Prisma's default connection-wait
   * window and threw `P2028 Unable to start a transaction in the given time`
   * before either transaction's body even ran, over this project's remote,
   * pooled connection. Both limits are widened so the loser waits instead of
   * erroring — that wait is the fix working as intended, not a hang.
   */
  static async applyTransition(
    input: TransitionInput,
    expectedFrom: ConnectionRequestStatus[],
  ): Promise<boolean> {
    const {
      userId,
      targetLinkedinId,
      toStatus,
      source,
      occurredAt,
      occurredAtIsEstimate = false,
      targetName,
      targetProfileUrl,
      actorLinkedinId,
    } = input;

    return prisma.$transaction(async (tx) => {
      const existingRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: ConnectionRequestStatus;
          targetName: string | null;
          targetProfileUrl: string | null;
          actorLinkedinId: string | null;
        }>
      >`
        SELECT id, status,
               target_name AS "targetName",
               target_profile_url AS "targetProfileUrl",
               actor_linkedin_id AS "actorLinkedinId"
        FROM connection_requests
        WHERE user_id = ${userId} AND target_linkedin_id = ${targetLinkedinId}
        FOR UPDATE
      `;
      const existing = existingRows[0];

      if (!existing || !expectedFrom.includes(existing.status)) return false;
      // A transition to the status it already holds is not a transition.
      if (existing.status === toStatus) return false;

      const when = occurredAt ?? new Date();

      await tx.connectionRequest.update({
        where: { id: existing.id },
        data: {
          status: toStatus,
          resolvedAt: when,
          // Absence is resolved once a terminal status is written.
          absentSince: null,
          ...(targetName != null && { targetName }),
          ...(targetProfileUrl != null && { targetProfileUrl }),
        },
      });

      await tx.connectionRequestEvent.create({
        data: {
          userId,
          targetLinkedinId,
          targetName: targetName ?? existing.targetName,
          targetProfileUrl: targetProfileUrl ?? existing.targetProfileUrl,
          actorLinkedinId: actorLinkedinId ?? existing.actorLinkedinId,
          fromStatus: existing.status,
          toStatus,
          occurredAt: when,
          occurredAtIsEstimate,
          source,
        },
      });

      return true;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Record a send (or re-send) and emit the matching event.
   *
   * Idempotent per (user, target): a repeat send re-opens the row to PENDING
   * unless it is already ACCEPTED — you cannot re-invite an existing connection.
   * Crucially, the row's previous outcome is overwritten but the EVENT for it
   * has already been recorded, so history survives.
   *
   * CONCURRENCY: when a row already exists, `SELECT ... FOR UPDATE` (as in
   * applyTransition above) makes the read-check-write atomic against a
   * concurrent racer. But a row lock can't protect a row that doesn't exist
   * yet — two concurrent FIRST sends to the SAME never-before-seen target
   * (e.g. two open LinkedIn tabs both intercepting a send to a brand-new
   * contact at the same instant) can both reach the `create()` branch and race
   * on the unique (userId, targetLinkedinId) constraint. One wins; the other
   * gets a unique-violation (P2002) and retries — the retry's own
   * `SELECT ... FOR UPDATE` then finds the winner's row and correctly takes
   * the update branch instead. This is the standard, documented way to handle
   * a rare insert race without a lock to hold: catch the conflict, retry once.
   */
  static async recordSent(input: TransitionInput): Promise<void> {
    const {
      userId,
      targetLinkedinId,
      source,
      occurredAt,
      occurredAtIsEstimate = false,
      targetName,
      targetProfileUrl,
      actorLinkedinId,
      actorName,
      actorPublicIdentifier,
      sentAtIsEstimate = false,
    } = input;

    const when = occurredAt ?? new Date();
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await prisma.$transaction(async (tx) => {
          const existingRows = await tx.$queryRaw<
            Array<{ id: string; status: ConnectionRequestStatus }>
          >`
            SELECT id, status FROM connection_requests
            WHERE user_id = ${userId} AND target_linkedin_id = ${targetLinkedinId}
            FOR UPDATE
          `;
          const existing = existingRows[0];

          // An existing ACCEPTED row is a real connection — never re-open it,
          // and no event for a send that didn't actually change anything.
          if (existing?.status === ConnectionRequestStatus.ACCEPTED) return;

          if (existing) {
            await tx.connectionRequest.update({
              where: { id: existing.id },
              data: {
                ...(targetProfileUrl != null && { targetProfileUrl }),
                ...(targetName != null && { targetName }),
                ...(actorLinkedinId != null && { actorLinkedinId }),
                ...(actorName != null && { actorName }),
                ...(actorPublicIdentifier != null && { actorPublicIdentifier }),
                status: ConnectionRequestStatus.PENDING,
                sentAt: when,
                sentAtIsEstimate,
                resolvedAt: null,
                absentSince: null,
              },
            });
          } else {
            await tx.connectionRequest.create({
              data: {
                userId,
                targetLinkedinId,
                targetProfileUrl: targetProfileUrl ?? null,
                targetName: targetName ?? null,
                actorLinkedinId: actorLinkedinId ?? null,
                actorName: actorName ?? null,
                actorPublicIdentifier: actorPublicIdentifier ?? null,
                status: ConnectionRequestStatus.PENDING,
                sentAt: when,
                sentAtIsEstimate,
              },
            });
          }

          await tx.connectionRequestEvent.create({
            data: {
              userId,
              targetLinkedinId,
              targetName: targetName ?? null,
              targetProfileUrl: targetProfileUrl ?? null,
              actorLinkedinId: actorLinkedinId ?? null,
              fromStatus: existing?.status ?? null,
              toStatus: ConnectionRequestStatus.PENDING,
              occurredAt: when,
              occurredAtIsEstimate,
              source,
            },
          });
        }, TRANSACTION_OPTIONS);
        return; // success
      } catch (err) {
        const isUniqueViolation =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002";
        if (isUniqueViolation && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  /**
   * Per-bucket counts over the EVENT history, bucketed on when things actually
   * happened. This is what the Connection Requests report reads for its time
   * series — unlike the current-state table, it survives re-sends.
   */
  static async getSeries(
    from: Date,
    to: Date,
    opts: {
      userId?: string;
      restrictUserIds?: string[];
      actorLinkedinId?: string;
      granularity?: "day" | "week" | "month";
    } = {},
  ): Promise<
    Array<{
      date: string;
      sent: number;
      accepted: number;
      withdrawn: number;
      expired: number;
    }>
  > {
    const { userId, restrictUserIds, actorLinkedinId } = opts;
    const bucket =
      opts.granularity === "week"
        ? "week"
        : opts.granularity === "month"
          ? "month"
          : "day";

    const ownerFilter = userId
      ? Prisma.sql`AND user_id = ${userId}`
      : restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${restrictUserIds})`
        : Prisma.empty;
    const actorFilter = actorLinkedinId
      ? Prisma.sql`AND actor_linkedin_id = ${actorLinkedinId}`
      : Prisma.empty;

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COUNT(*) FILTER (WHERE to_status = 'PENDING')::int   AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM connection_request_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${actorFilter}
      GROUP BY 1
      ORDER BY 1
    `;
  }

  /**
   * Totals over the event history for a window. `sent` counts every send
   * INCLUDING re-sends, which is the honest answer to "how many requests went
   * out" — the current-state table can only ever report one per contact.
   */
  static async getTotals(
    from: Date,
    to: Date,
    opts: {
      userId?: string;
      restrictUserIds?: string[];
      actorLinkedinId?: string;
    } = {},
  ): Promise<{
    sent: number;
    accepted: number;
    withdrawn: number;
    expired: number;
  }> {
    const { userId, restrictUserIds, actorLinkedinId } = opts;
    const ownerFilter = userId
      ? Prisma.sql`AND user_id = ${userId}`
      : restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${restrictUserIds})`
        : Prisma.empty;
    const actorFilter = actorLinkedinId
      ? Prisma.sql`AND actor_linkedin_id = ${actorLinkedinId}`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<
      Array<{ sent: number; accepted: number; withdrawn: number; expired: number }>
    >`
      SELECT COUNT(*) FILTER (WHERE to_status = 'PENDING')::int   AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM connection_request_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${actorFilter}
    `;
    const r = rows[0];
    return {
      sent: r?.sent ?? 0,
      accepted: r?.accepted ?? 0,
      withdrawn: r?.withdrawn ?? 0,
      expired: r?.expired ?? 0,
    };
  }
}
