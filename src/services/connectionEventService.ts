// src/services/connectionEventService.ts
import {
  ConnectionEventSource,
  ConnectionRequestStatus,
  Prisma,
} from "@prisma/client";
import prisma from "../config/prisma";

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

// LinkedIn expires sent invitations after ~6 months. Confirmed two ways: its
// help documentation, and observation — an account with ~1 year of continuous
// invitations retains nothing older than 6 months in the Sent list. Configurable
// because LinkedIn has changed this policy before.
//
// A misconfigured env var (non-numeric, out of range) falls back to the
// default rather than propagating NaN into estimateExpiryDate — an Invalid
// Date written to resolvedAt would fail the DB write for that reconcile pass.
const invitExpiryMonthsEnv = Number(process.env.LINKEDIN_INVITE_EXPIRY_MONTHS);
export const INVITE_EXPIRY_MONTHS =
  Number.isFinite(invitExpiryMonthsEnv) && invitExpiryMonthsEnv > 0 && invitExpiryMonthsEnv <= 60
    ? invitExpiryMonthsEnv
    : 6;

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
  const aged = addMonthsClamped(sentAt, INVITE_EXPIRY_MONTHS);
  return aged <= detectedAt ? aged : detectedAt;
};

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
   * Returns true when the transition actually applied.
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
      const existing = await tx.connectionRequest.findUnique({
        where: { userId_targetLinkedinId: { userId, targetLinkedinId } },
        select: {
          id: true,
          status: true,
          targetName: true,
          targetProfileUrl: true,
          actorLinkedinId: true,
        },
      });

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
    });
  }

  /**
   * Record a send (or re-send) and emit the matching event.
   *
   * Idempotent per (user, target): a repeat send re-opens the row to PENDING
   * unless it is already ACCEPTED — you cannot re-invite an existing connection.
   * Crucially, the row's previous outcome is overwritten but the EVENT for it
   * has already been recorded, so history survives.
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

    await prisma.$transaction(async (tx) => {
      const existing = await tx.connectionRequest.findUnique({
        where: { userId_targetLinkedinId: { userId, targetLinkedinId } },
        select: { id: true, status: true },
      });

      if (!existing) {
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
      } else {
        // An existing ACCEPTED row is a real connection — never re-open it.
        if (existing.status === ConnectionRequestStatus.ACCEPTED) return;

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
    });
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
