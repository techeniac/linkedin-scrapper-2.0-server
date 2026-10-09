// src/repositories/ownerOverrideRepository.ts
//
// Data-access layer for the manual owner-override write path. See the
// design doc for the full reasoning:
// docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md
import prisma from "../config/prisma";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
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
        -- Prefer a human-corrected row over whichever scraper's row Postgres
        -- would otherwise return arbitrarily — see applyOverride below.
        ORDER BY m.participant_name_overridden DESC
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
   * state guard, flips the cache row to 'manual', re-stamps EVERY
   * message_events row for this conversation (its full history, not just
   * new rows — see design doc Goal 3), optionally corrects the participant
   * name uniformly across every scraper's message_activity row, and inserts
   * an audit row — ALL as ONE raw statement (one round trip), so the guard
   * flip, the event/activity restamp, and the audit insert either all land
   * together or none do. A prior version of this method split the guard
   * flip into its own round trip from the event/audit writes; a crash or
   * failure between the two left the cache permanently flipped to 'manual'
   * with no audit row and stale event attribution — exactly what this
   * table exists to prevent (see its own header comment). Folding
   * everything into one statement closes that gap without needing an
   * interactive transaction.
   *
   * Deliberately NOT an interactive `prisma.$transaction(async tx => ...)`:
   * this DB sits behind a Supavisor TRANSACTION-mode pooler (see .env),
   * which does not reliably hold one connection across the multiple
   * round-trips an interactive transaction needs — confirmed by a
   * `P2028 Transaction not found` failure when this was tried. A single
   * `$queryRaw` with chained writable CTEs is one round trip, so the
   * pooler is a non-issue, and Postgres still runs the whole statement —
   * every CTE included — under one snapshot/transaction implicitly.
   *
   * The guard is race-safe without any application-level locking: the `old`
   * CTE's `FOR UPDATE` takes a row lock, so a second concurrent call for
   * the same conversationKey blocks until the first's statement commits,
   * then re-reads the now-committed row — if that row is no longer
   * 'ambiguous', `old` (and therefore every CTE chained from it below)
   * returns no rows, nothing else in the statement touches any row, and
   * the caller gets a 409 instead of a corrupted audit row built from
   * stale "before" values.
   */
  static async applyOverride(params: {
    conversationKey: string;
    newOwnerId: string;
    performedByEmail: string;
    participantName?: string;
  }): Promise<void> {
    const { conversationKey, newOwnerId, performedByEmail, participantName } = params;
    const auditId = randomUUID();

    // Only run when a name was actually provided; omitted-field means no
    // name change. participantNameOverridden protects this value from the
    // scraper sync's own COALESCE-based merge
    // (messageActivityRepository.upsert) — without it, the next sync of
    // this conversation silently reverts the correction back to LinkedIn's
    // raw captured name. Chained onto cache_update (not just conversationKey)
    // so it only touches rows when the guard above actually passed.
    //
    // activity_done/events_done wrap each UPDATE's RETURNING in a no-GROUP-BY
    // aggregate: a data-modifying CTE in Postgres only runs if something
    // reachable from the primary query references it, and `count(*)` always
    // collapses to exactly one row regardless of how many message_activity /
    // message_events rows were touched — so joining these onto the final
    // INSERT SELECT both guarantees the writes actually run and can never
    // multiply the single audit row being inserted.
    const activityUpdateCte = participantName
      ? Prisma.sql`,
      activity_update AS (
        UPDATE message_activity m
        SET participant_name = ${participantName}, participant_name_overridden = true
        FROM cache_update
        WHERE m.conversation_key = ${conversationKey}
        RETURNING 1
      ),
      activity_done AS (SELECT count(*)::int AS n FROM activity_update)`
      : Prisma.sql`, activity_done AS (SELECT 0 AS n)`;

    const result = await prisma.$queryRaw<Array<{ oldOwnerId: string | null; oldAmbiguousReason: string | null }>>`
      WITH old AS (
        SELECT resolved_owner_id, ambiguous_reason
        FROM conversation_owner_cache
        WHERE conversation_key = ${conversationKey} AND attribution_source = 'ambiguous'
        FOR UPDATE
      ),
      cache_update AS (
        UPDATE conversation_owner_cache c
        SET resolved_owner_id = ${newOwnerId}, attribution_source = 'manual', ambiguous_reason = NULL, resolved_at = NOW()
        FROM old
        WHERE c.conversation_key = ${conversationKey}
        RETURNING old.resolved_owner_id AS old_owner_id, old.ambiguous_reason AS old_ambiguous_reason
      ),
      -- Cross-scraper "name in effect before this override" — see the
      -- design doc's reasoning (same lookup as
      -- messageOwnerResolverService.ts), preferring a row a prior override
      -- already corrected over whichever scraper's row Postgres would
      -- otherwise return arbitrarily. Read in the SAME statement/snapshot
      -- as the cache flip above, so no concurrent scraper sync can land in
      -- between the guard and this read.
      old_name AS (
        SELECT participant_name
        FROM message_activity
        WHERE conversation_key = ${conversationKey} AND participant_name IS NOT NULL
        ORDER BY participant_name_overridden DESC
        LIMIT 1
      ),
      events_update AS (
        UPDATE message_events e
        SET resolved_owner_id = ${newOwnerId}, attribution_source = 'manual'
        FROM cache_update
        WHERE e.conversation_key = ${conversationKey}
        RETURNING 1
      ),
      events_done AS (SELECT count(*)::int AS n FROM events_update)${activityUpdateCte}
      INSERT INTO owner_override_audit (
        id, conversation_key, old_owner_id, new_owner_id, performed_by_email,
        performed_at, ambiguous_reason, old_participant_name, new_participant_name
      )
      SELECT ${auditId}, ${conversationKey}, cache_update.old_owner_id, ${newOwnerId}, ${performedByEmail},
             NOW(), cache_update.old_ambiguous_reason, old_name.participant_name, ${participantName ?? null}
      FROM cache_update
      LEFT JOIN old_name ON true
      CROSS JOIN events_done
      CROSS JOIN activity_done
      RETURNING old_owner_id AS "oldOwnerId", ambiguous_reason AS "oldAmbiguousReason"
    `;

    if (result.length === 0) {
      throw new ConflictError("Conversation is not in a resolvable state");
    }
  }
}
