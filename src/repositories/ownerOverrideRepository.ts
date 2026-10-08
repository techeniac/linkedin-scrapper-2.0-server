// src/repositories/ownerOverrideRepository.ts
//
// Data-access layer for the manual owner-override write path. See the
// design doc for the full reasoning:
// docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md
import prisma from "../config/prisma";
import { Prisma } from "@prisma/client";

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

  static async findCachedOwner(conversationKey: string): Promise<{ resolvedOwnerId: string | null } | null> {
    return prisma.conversationOwnerCache.findUnique({
      where: { conversationKey },
      select: { resolvedOwnerId: true },
    });
  }

  static async isScraperOfConversation(conversationKey: string, scraperUserId: string): Promise<boolean> {
    const row = await prisma.messageEvent.findFirst({
      where: { conversationKey, userId: scraperUserId },
      select: { conversationKey: true },
    });
    return row !== null;
  }

  /**
   * The "before" state for an override's audit snapshot: the conversation's
   * current attribution_source + ambiguous_reason (to check it's actually
   * overridable, and to snapshot the reason), plus the current cross-scraper
   * participant name (same LATERAL-join reasoning as listAmbiguous's `pn`
   * subquery and the resolver's own cross-scraper lookup — any scraper's
   * captured name for this conversationKey is the "current" one).
   */
  static async getOverrideSnapshot(
    conversationKey: string,
  ): Promise<{ attributionSource: string | null; ambiguousReason: string | null; participantName: string | null }> {
    const cache = await prisma.conversationOwnerCache.findUnique({
      where: { conversationKey },
      select: { attributionSource: true, ambiguousReason: true },
    });
    const activity = await prisma.messageActivity.findFirst({
      where: { conversationKey, participantName: { not: null } },
      select: { participantName: true },
    });
    return {
      attributionSource: cache?.attributionSource ?? null,
      ambiguousReason: cache?.ambiguousReason ?? null,
      participantName: activity?.participantName ?? null,
    };
  }

  /**
   * Applies a manual owner override atomically: upserts the cache row to
   * 'manual', re-stamps EVERY message_events row for this conversation (its
   * full history, not just new rows — see design doc Goal 3), and inserts an
   * audit row — all in one transaction so a crash mid-write can never leave
   * the cache, the event rows, and the audit trail disagreeing.
   */
  static async applyOverride(params: {
    conversationKey: string;
    oldOwnerId: string | null;
    newOwnerId: string;
    performedByEmail: string;
    participantName?: string;
    ambiguousReason: string | null;
    oldParticipantName: string | null;
  }): Promise<void> {
    const { conversationKey, oldOwnerId, newOwnerId, performedByEmail, participantName, ambiguousReason, oldParticipantName } =
      params;
    await prisma.$transaction([
      prisma.conversationOwnerCache.upsert({
        where: { conversationKey },
        create: { conversationKey, resolvedOwnerId: newOwnerId, attributionSource: "manual" },
        update: { resolvedOwnerId: newOwnerId, attributionSource: "manual", ambiguousReason: null, resolvedAt: new Date() },
      }),
      prisma.messageEvent.updateMany({
        where: { conversationKey },
        data: { resolvedOwnerId: newOwnerId, attributionSource: "manual" },
      }),
      // Uniform across every scraper's row for this conversationKey — see
      // design doc Goal 3 / Review Focus item 4. Only run when a name was
      // actually provided; omitted-field means no name change.
      ...(participantName
        ? [
            prisma.messageActivity.updateMany({
              where: { conversationKey },
              data: { participantName },
            }),
          ]
        : []),
      prisma.ownerOverrideAudit.create({
        data: {
          conversationKey,
          oldOwnerId,
          newOwnerId,
          performedByEmail,
          ambiguousReason,
          oldParticipantName,
          newParticipantName: participantName ?? null,
        },
      }),
    ]);
  }
}
