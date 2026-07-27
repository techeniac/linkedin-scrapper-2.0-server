import axios from "axios";
import sanitizeHtml from "sanitize-html";

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
    const titleMatch = body.match(/<b>(.*?)<\/b><br\/><br\/>/);
    return {
      noteTitle: titleMatch?.[1] || null,
      notes: titleMatch
        ? body.replace(/<b>.*?<\/b><br\/><br\/>/, "").trim()
        : body,
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

  async getNotesByContact(contactId: string) {
    const response = await axios.get(
      `${this.baseUrl}/crm/v4/objects/contacts/${contactId}/associations/notes`,
      { headers: this.headers },
    );

    const noteIds = response.data.results?.map((r: any) => r.toObjectId) || [];
    if (noteIds.length === 0) return [];

    const notesResponse = await axios.post(
      `${this.baseUrl}/crm/v3/objects/notes/batch/read`,
      {
        properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
        inputs: noteIds.map((id: string) => ({ id })),
      },
      { headers: this.headers },
    );

    return (notesResponse.data.results || []).map((note: any) => {
      const parsed = this.parseNoteBody(note.properties?.hs_note_body || "");
      return {
        id: note.id,
        noteTitle: this.sanitizeNoteText(parsed.noteTitle),
        notes: this.sanitizeNoteText(parsed.notes),
        timestamp: note.properties?.hs_timestamp,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
    });
  }

  async updateNote(noteId: string, data: { noteTitle?: string; notes: string }) {
    let noteBody = data.notes;
    if (data.noteTitle) {
      noteBody = `<b>${data.noteTitle}</b><br/><br/>` + data.notes;
    }

    const response = await axios.patch(
      `${this.baseUrl}/crm/v3/objects/notes/${noteId}`,
      { properties: { hs_note_body: noteBody } },
      { headers: this.headers },
    );

    return response.data;
  }

  async deleteNote(noteId: string): Promise<void> {
    await axios.delete(`${this.baseUrl}/crm/v3/objects/notes/${noteId}`, {
      headers: this.headers,
    });
  }
}
