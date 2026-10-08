// src/repositories/ownerOverrideRepository.ts
//
// Data-access layer for the manual owner-override write path. See the
// design doc for the full reasoning:
// docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md
import prisma from "../config/prisma";
import { Prisma } from "@prisma/client";
import { ConflictError } from "../errors/AppError";

export interface AmbiguousConversation {
  conversationKey: string;
  resolvedAt: Date;
  participantName: string | null;
  ambiguousReason: string | null;
}

export type AmbiguousSortBy = "resolvedAt" | "participantName";
export type SortOrder = "asc" | "desc";

// conversationKey -> participant_name is looked up via a LATERAL join
// (first non-null name from any scraper's message_activity row for that
// conversation — see messageOwnerResolverService.ts's own cross-scraper
// lookup for the same reasoning) directly in SQL, so search/sort/pagination
// can all happen at the DB level instead of over an unbounded in-memory set.
const SORT_COLUMNS: Record<AmbiguousSortBy, string> = {
  resolvedAt: "c.resolved_at",
  participantName: "pn.participant_name",
};

export class OwnerOverrideRepository {
  /**
   * Paginated/filtered/sorted conversations currently cached as 'ambiguous'.
   * When scraperUserId is given, narrowed to conversations where that
   * scraper recorded at least one message_events row for the conversation —
   * the shared-LinkedIn-account reality that any scraper who touched a
   * conversation can resolve it (see the design doc's GET
   * /api/owner-overrides scope rule).
   */
  static async listAmbiguous(params: {
    scraperUserId?: string;
    page: number;
    limit: number;
    sortBy: AmbiguousSortBy;
    sortOrder: SortOrder;
    search?: string;
  }): Promise<{ data: AmbiguousConversation[]; total: number }> {
    const { scraperUserId, page, limit, sortBy, sortOrder, search } = params;
    const offset = (page - 1) * limit;

    const scraperFilter = scraperUserId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM message_events m2 WHERE m2.conversation_key = c.conversation_key AND m2.user_id = ${scraperUserId})`
      : Prisma.empty;
    const searchFilter = search
      ? Prisma.sql`AND (pn.participant_name ILIKE ${"%" + search + "%"} OR c.conversation_key ILIKE ${"%" + search + "%"})`
      : Prisma.empty;
    // Column name can't be bound as a query param — Prisma.raw here is safe
    // only because it's drawn from the fixed SORT_COLUMNS map, never from
    // the raw request value directly.
    const orderClause = Prisma.raw(
      `${SORT_COLUMNS[sortBy]} ${sortOrder === "asc" ? "ASC" : "DESC"} NULLS LAST`,
    );

    const fromAndWhere = Prisma.sql`
      FROM conversation_owner_cache c
      LEFT JOIN LATERAL (
        SELECT participant_name
        FROM message_activity m
        WHERE m.conversation_key = c.conversation_key AND m.participant_name IS NOT NULL
        LIMIT 1
      ) pn ON true
      WHERE c.attribution_source = 'ambiguous'
        ${scraperFilter}
        ${searchFilter}
    `;

    const [data, countRows] = await Promise.all([
      prisma.$queryRaw<AmbiguousConversation[]>`
        SELECT c.conversation_key AS "conversationKey",
               c.resolved_at AS "resolvedAt",
               pn.participant_name AS "participantName",
               c.ambiguous_reason AS "ambiguousReason"
        ${fromAndWhere}
        ORDER BY ${orderClause}
        LIMIT ${limit} OFFSET ${offset}
      `,
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        ${fromAndWhere}
      `,
    ]);

    return { data, total: countRows[0]?.count ?? 0 };
  }

  static async isScraperOfConversation(conversationKey: string, scraperUserId: string): Promise<boolean> {
    const row = await prisma.messageEvent.findFirst({
      where: { conversationKey, userId: scraperUserId },
      select: { conversationKey: true },
    });
    return row !== null;
  }

  /**
   * Applies a manual owner override: atomically re-checks the ambiguous-
   * state guard and flips the cache row to 'manual' in one round trip, then
   * re-stamps EVERY message_events row for this conversation (its full
   * history, not just new rows — see design doc Goal 3), optionally
   * corrects the participant name uniformly across every scraper's
   * message_activity row, and inserts an audit row.
   *
   * Deliberately NOT an interactive `prisma.$transaction(async tx => ...)`:
   * this DB sits behind a Supavisor TRANSACTION-mode pooler (see .env),
   * which does not reliably hold one connection across the multiple
   * round-trips an interactive transaction needs — confirmed by a
   * `P2028 Transaction not found` failure when this was tried. The guard
   * below is instead a single raw statement (one round trip, so the pooler
   * is a non-issue), and the remaining writes use the array-style
   * `$transaction([...])` the rest of this codebase already relies on.
   *
   * The guard is race-safe without any application-level locking: the `old`
   * CTE's `FOR UPDATE` takes a row lock, so a second concurrent call for
   * the same conversationKey blocks until the first's statement commits,
   * then re-reads the now-committed row — if that row is no longer
   * 'ambiguous', the CTE returns no rows, the UPDATE (joined FROM old)
   * touches no rows, and the caller gets a 409 instead of a corrupted
   * audit row built from stale "before" values. The CTE's RETURNING also
   * hands back those "before" values in the same statement, since by the
   * time a plain RETURNING could see them, the UPDATE would already have
   * overwritten them.
   */
  static async applyOverride(params: {
    conversationKey: string;
    newOwnerId: string;
    performedByEmail: string;
    participantName?: string;
  }): Promise<void> {
    const { conversationKey, newOwnerId, performedByEmail, participantName } = params;

    const guarded = await prisma.$queryRaw<Array<{ oldOwnerId: string | null; oldAmbiguousReason: string | null }>>`
      WITH old AS (
        SELECT resolved_owner_id, ambiguous_reason
        FROM conversation_owner_cache
        WHERE conversation_key = ${conversationKey} AND attribution_source = 'ambiguous'
        FOR UPDATE
      )
      UPDATE conversation_owner_cache c
      SET resolved_owner_id = ${newOwnerId}, attribution_source = 'manual', ambiguous_reason = NULL, resolved_at = NOW()
      FROM old
      WHERE c.conversation_key = ${conversationKey}
      RETURNING old.resolved_owner_id AS "oldOwnerId", old.ambiguous_reason AS "oldAmbiguousReason"
    `;
    if (guarded.length === 0) {
      throw new ConflictError("Conversation is not in a resolvable state");
    }
    const { oldOwnerId, oldAmbiguousReason } = guarded[0];

    const activity = await prisma.messageActivity.findFirst({
      where: { conversationKey, participantName: { not: null } },
      select: { participantName: true },
    });

    await prisma.$transaction([
      prisma.messageEvent.updateMany({
        where: { conversationKey },
        data: { resolvedOwnerId: newOwnerId, attributionSource: "manual" },
      }),
      // Uniform across every scraper's row for this conversationKey — see
      // design doc Goal 3 / Review Focus item 4. Only run when a name was
      // actually provided; omitted-field means no name change.
      // participantNameOverridden protects this value from the scraper
      // sync's own COALESCE-based merge (messageActivityRepository.upsert) —
      // without it, the next sync of this conversation silently reverts the
      // correction back to LinkedIn's raw captured name.
      ...(participantName
        ? [
            prisma.messageActivity.updateMany({
              where: { conversationKey },
              data: { participantName, participantNameOverridden: true },
            }),
          ]
        : []),
      prisma.ownerOverrideAudit.create({
        data: {
          conversationKey,
          oldOwnerId,
          newOwnerId,
          performedByEmail,
          ambiguousReason: oldAmbiguousReason,
          oldParticipantName: activity?.participantName ?? null,
          newParticipantName: participantName ?? null,
        },
      }),
    ]);
  }
}
