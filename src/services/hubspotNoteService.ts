import axios from "axios";
import sanitizeHtml from "sanitize-html";
import { PaginatedNotesResult, NoteItem, ContactListItem } from "../types/hubspot.types";
import logger from "../utils/logger";

export class HubSpotNoteService {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string>,
  ) {}

  private sanitizeNoteText(text: string | null | undefined): string | null {
    if (!text) return null;
    const cleaned = sanitizeHtml(text, {
      allowedTags: [],
      allowedAttributes: {},
    });
    return cleaned.replace(/\s+/g, " ").trim() || null;
  }

  private parseNoteBody(body: string): {
    noteTitle: string | null;
    notes: string;
  } {
    // HubSpot normalizes <br/> → <br> or <br /> on return, so match all variants.
    // Also handle 1 or 2 <br> tags after the title.
    const titleMatch = body.match(/^<b>(.*?)<\/b>(?:<br\s*\/?>\s*){1,2}/i);
    if (!titleMatch) return { noteTitle: null, notes: body };
    return {
      noteTitle: titleMatch[1] || null,
      notes: body.slice(titleMatch[0].length).trim(),
    };
  }

  private mapNoteResult(note: any): NoteItem {
    const parsed = this.parseNoteBody(note.properties?.hs_note_body || "");
    return {
      id: note.id,
      noteTitle: this.sanitizeNoteText(parsed.noteTitle),
      notes: this.sanitizeNoteText(parsed.notes),
      timestamp: note.properties?.hs_timestamp || note.createdAt,
    };
  }

  async createNote(data: {
    noteTitle?: string;
    notes: string;
    contactId?: string;
    ownerId?: string;
  }) {
    let noteBody = data.notes;
    if (data.noteTitle) {
      noteBody = `<b>${data.noteTitle}</b><br/><br/>` + data.notes;
    }

    const response = await axios.post(
      `${this.baseUrl}/crm/v3/objects/notes`,
      {
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: new Date().toISOString(),
          hubspot_owner_id: data.ownerId || undefined,
        },
        associations: [
          {
            to: { id: data.contactId },
            types: [
              { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 },
            ],
          },
        ],
      },
      { headers: this.headers },
    );

    return response.data;
  }

  async getNotesByContact(
    contactId: string,
    options: { limit?: number; after?: string } = {},
  ): Promise<PaginatedNotesResult> {
    const limit = Math.min(50, options.limit ?? 20);

    const assocUrl = new URL(
      `${this.baseUrl}/crm/v4/objects/contacts/${contactId}/associations/notes`,
    );
    assocUrl.searchParams.set("limit", String(limit));
    if (options.after) assocUrl.searchParams.set("after", options.after);

    const assocResponse = await axios.get(assocUrl.toString(), {
      headers: this.headers,
    });

    const noteIds: string[] =
      assocResponse.data.results?.map((r: any) => String(r.toObjectId)) ?? [];

    if (noteIds.length === 0) {
      return { notes: [], hasMore: false, nextCursor: null };
    }

    const nextCursor: string | null =
      assocResponse.data.paging?.next?.after ?? null;
    const hasMore = nextCursor !== null;

    const notesResponse = await axios.post(
      `${this.baseUrl}/crm/v3/objects/notes/batch/read`,
      {
        properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
        inputs: noteIds.map((id) => ({ id })),
      },
      { headers: this.headers },
    );

    const notes = (notesResponse.data.results || [])
      .map((n: any) => this.mapNoteResult(n))
      .sort(
        (a: any, b: any) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

    return { notes, hasMore, nextCursor };
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  // Fetch ALL notes for the given contacts in two parallelised batch rounds.
  // Round 1: contact IDs → note IDs  (contacts/notes associations, 100 contacts/call)
  // Round 2: note IDs  → note bodies  (notes batch/read,             100 notes/call)
  // Contact names/companies come from the passed map — no extra API calls needed.
  async getAllNotesByContacts(contacts: ContactListItem[]): Promise<NoteItem[]> {
    if (contacts.length === 0) return [];

    const contactInfoMap = new Map(
      contacts.map((c) => [c.id, { name: c.name, company: c.company }]),
    );
    const contactIds = contacts.map((c) => c.id);

    // Round 1: contacts → note IDs (parallel, 100 contacts per call)
    const assocChunks = this.chunkArray(contactIds, 100);
    const assocResponses = await Promise.all(
      assocChunks.map((ids) =>
        axios
          .post(
            `${this.baseUrl}/crm/v4/associations/contacts/notes/batch/read`,
            { inputs: ids.map((id) => ({ id })) },
            { headers: this.headers },
          )
          .catch((err) => {
            logger.warn(`[HubSpot] contacts→notes assoc chunk failed: ${err.message}`);
            return { data: { results: [] } };
          }),
      ),
    );

    const noteContactMap = new Map<string, string>(); // noteId → contactId
    for (const res of assocResponses) {
      for (const r of res.data?.results ?? []) {
        const contactId = String(r.from.id);
        for (const t of r.to ?? []) {
          noteContactMap.set(String(t.toObjectId), contactId);
        }
      }
    }

    const allNoteIds = [...noteContactMap.keys()];
    if (allNoteIds.length === 0) return [];

    // Round 2: note IDs → note bodies (parallel, 100 notes per call)
    const noteChunks = this.chunkArray(allNoteIds, 100);
    const noteResponses = await Promise.all(
      noteChunks.map((ids) =>
        axios
          .post(
            `${this.baseUrl}/crm/v3/objects/notes/batch/read`,
            {
              properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
              inputs: ids.map((id) => ({ id })),
            },
            { headers: this.headers },
          )
          .catch((err) => {
            logger.warn(`[HubSpot] notes batch/read chunk failed: ${err.message}`);
            return { data: { results: [] } };
          }),
      ),
    );

    const notes: NoteItem[] = [];
    for (const res of noteResponses) {
      for (const n of res.data?.results ?? []) {
        const note = this.mapNoteResult(n);
        const contactId = noteContactMap.get(note.id);
        if (!contactId) continue; // orphan — skip
        const info = contactInfoMap.get(contactId);
        note.contactId = contactId;
        note.contactName = info?.name;
        note.contactCompany = info?.company;
        notes.push(note);
      }
    }

    notes.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return notes;
  }

  async getNotesByOwner(
    ownerId: string,
    options: { limit?: number; after?: string; ownedContactIds?: Set<string> } = {},
  ): Promise<PaginatedNotesResult> {
    const limit = Math.min(50, options.limit ?? 20);

    // Filter by note's hubspot_owner_id only as a starting scope — notes without
    // this field (created externally or via HubSpot web app) will be caught by
    // a second pass via contact ownership check below.
    // We intentionally use a broad filter (notes with ANY owner OR no owner
    // that are associated with our contacts) so we don't miss notes.
    // If ownedContactIds is provided, that set is the authoritative ownership filter.
    const payload: any = {
      filterGroups: options.ownedContactIds
        ? [{ filters: [{ propertyName: "hs_timestamp", operator: "HAS_PROPERTY" }] }]
        : [{ filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }] }],
      properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
      sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
      limit,
    };

    if (options.after) payload.after = options.after;

    const response = await axios.post(
      `${this.baseUrl}/crm/v3/objects/notes/search`,
      payload,
      { headers: this.headers },
    );

    const nextCursor: string | null =
      response.data.paging?.next?.after ?? null;

    const notes: NoteItem[] = (response.data.results || []).map((n: any) =>
      this.mapNoteResult(n),
    );

    // Attach contactId + contactName + contactCompany to each note.
    if (notes.length > 0) {
      try {
        // Step 1: note → contact associations (one batch call).
        const assocRes = await axios.post(
          `${this.baseUrl}/crm/v4/associations/notes/contacts/batch/read`,
          { inputs: notes.map((n) => ({ id: n.id })) },
          { headers: this.headers },
        );
        const contactMap = new Map<string, string>(); // noteId → contactId
        for (const r of assocRes.data?.results ?? []) {
          const contactId = r.to?.[0]?.toObjectId;
          if (r.from?.id && contactId) {
            contactMap.set(String(r.from.id), String(contactId));
          }
        }
        for (const note of notes) {
          const contactId = contactMap.get(note.id);
          if (contactId) note.contactId = contactId;
        }

        // Step 2: batch-read contact name + company for every unique contactId.
        const uniqueContactIds = [...new Set([...contactMap.values()])];
        if (uniqueContactIds.length > 0) {
          const contactRes = await axios.post(
            `${this.baseUrl}/crm/v3/objects/contacts/batch/read`,
            {
              properties: ["firstname", "lastname", "company", "associatedcompanyid"],
              inputs: uniqueContactIds.map((id) => ({ id })),
            },
            { headers: this.headers },
          );

          // Build name/company map; collect contacts missing company text field.
          type ContactInfo = { name: string; company?: string; assocCompanyId?: string };
          const infoMap = new Map<string, ContactInfo>();
          for (const c of contactRes.data?.results ?? []) {
            const first = c.properties?.firstname || "";
            const last = c.properties?.lastname || "";
            infoMap.set(String(c.id), {
              name: [first, last].filter(Boolean).join(" ") || String(c.id),
              company: c.properties?.company || undefined,
              assocCompanyId: c.properties?.associatedcompanyid || undefined,
            });
          }

          // Step 3: for contacts without a company text property but with an
          // associated company object, batch-read company names (one extra call).
          const missingCompany = [...infoMap.entries()].filter(
            ([, info]) => !info.company && info.assocCompanyId,
          );
          if (missingCompany.length > 0) {
            try {
              const companyIds = [...new Set(missingCompany.map(([, i]) => i.assocCompanyId!))];
              const compRes = await axios.post(
                `${this.baseUrl}/crm/v3/objects/companies/batch/read`,
                { properties: ["name"], inputs: companyIds.map((id) => ({ id })) },
                { headers: this.headers },
              );
              const compNameMap = new Map<string, string>();
              for (const co of compRes.data?.results ?? []) {
                if (co.id && co.properties?.name) compNameMap.set(String(co.id), co.properties.name);
              }
              for (const [contactId, info] of missingCompany) {
                const name = compNameMap.get(info.assocCompanyId!);
                if (name) infoMap.get(contactId)!.company = name;
              }
            } catch (err: any) {
              logger.warn(`[HubSpot] Could not fetch associated company names for notes: ${err.message}`);
            }
          }

          // Attach name + company to each note.
          for (const note of notes) {
            if (note.contactId) {
              const info = infoMap.get(note.contactId);
              if (info) {
                note.contactName = info.name;
                note.contactCompany = info.company;
              }
            }
          }
        }
      } catch (err: any) {
        logger.warn(`[HubSpot] Could not fetch note-contact associations: ${err.message}`);
      }
    }

    // Keep only notes that have a contact association AND (if ownedContactIds is
    // provided) whose contact is owned by this user. This replaces the unreliable
    // note-level hubspot_owner_id filter with a contact-ownership check.
    const filtered = notes.filter(
      (n) =>
        !!n.contactId &&
        (!options.ownedContactIds || options.ownedContactIds.has(n.contactId!)),
    );

    return { notes: filtered, hasMore: nextCursor !== null, nextCursor };
  }

  async getNoteOwner(noteId: string): Promise<string | null> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/crm/v3/objects/notes/${noteId}`,
        { params: { properties: "hubspot_owner_id" }, headers: this.headers },
      );
      return response.data?.properties?.hubspot_owner_id || null;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async updateNote(noteId: string, data: { noteTitle?: string; notes: string }) {
    let noteBody = data.notes;
    if (data.noteTitle) {
      noteBody = `<b>${data.noteTitle}</b><br/><br/>` + data.notes;
    }

    try {
      const response = await axios.patch(
        `${this.baseUrl}/crm/v3/objects/notes/${noteId}`,
        { properties: { hs_note_body: noteBody } },
        { headers: this.headers },
      );
      return response.data;
    } catch (error: any) {
      throw new Error(`Failed to update note: ${error.response?.data?.message ?? error.message}`);
    }
  }

  async deleteNote(noteId: string): Promise<void> {
    try {
      await axios.delete(`${this.baseUrl}/crm/v3/objects/notes/${noteId}`, {
        headers: this.headers,
      });
    } catch (error: any) {
      throw new Error(`Failed to delete note: ${error.response?.data?.message ?? error.message}`);
    }
  }
}
