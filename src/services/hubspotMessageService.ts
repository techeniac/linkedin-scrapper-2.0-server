import axios from "axios";
import {
  LinkedInMessage,
  UpsertMessagesResponse,
  MessageSyncResult,
} from "../types";
import logger from "../utils/logger";
import { extractLinkedInHandle, generateThreadId } from "./hubspotHelpers";
import { HubSpotContactService } from "./hubspotContactService";

export class HubSpotMessageService {
  private contactService: HubSpotContactService;

  constructor(
    private baseUrl: string,
    private headers: Record<string, string>,
  ) {
    this.contactService = new HubSpotContactService(baseUrl, headers);
  }

  async upsertLinkedInMessages(
    conversationKey: string,
    messages: LinkedInMessage[],
    ownerId?: string,
  ): Promise<UpsertMessagesResponse> {
    logger.info(
      `[Messages] Starting sync for conversation: ${conversationKey}`,
    );

    try {
      const contactPerson = this.identifyContactPerson(messages);
      const handle = extractLinkedInHandle(contactPerson.profileUrl);
      if (!handle) throw new Error("Invalid LinkedIn profile URL");

      const contact = await this.contactService.findContactByProfileUrl(handle);
      if (!contact) {
        throw new Error(
          "Contact not found in HubSpot. Please sync the contact first.",
        );
      }

      const existingComms = await this.getExistingCommunications(contact.id);

      const existingByDate = new Map<string, string>();
      for (const comm of existingComms) {
        const commDate = comm.timestamp.split("T")[0];
        logger.info(`[DEBUG] Existing comm date: ${commDate}, ID: ${comm.id}`);
        existingByDate.set(commDate, comm.id);
      }

      const messagesByDate = this.groupMessagesByDate(messages);
      const results: MessageSyncResult[] = [];
      let syncedCount = 0;

      for (const [date, dayMessages] of messagesByDate) {
        logger.info(
          `[DEBUG] Checking date: ${date}, exists: ${existingByDate.has(date)}`,
        );
        const result = await this.upsertDailyCommunication(
          contact.id,
          date,
          dayMessages,
          existingByDate.get(date),
          ownerId,
        );
        results.push(result);
        syncedCount++;
      }

      return {
        success: true,
        threadId: generateThreadId(conversationKey),
        contactId: contact.id,
        synced: syncedCount,
        skipped: 0,
        messages: results,
      };
    } catch (error: any) {
      logger.error(`[Messages] Sync failed: ${error.message}`);
      throw error;
    }
  }

  private identifyContactPerson(messages: LinkedInMessage[]): {
    name: string;
    profileUrl: string;
  } {
    for (const message of messages) {
      if (message.sender.distance !== "SELF") {
        return { name: message.sender.name, profileUrl: message.sender.profileUrl };
      }
      if (message.receiver.distance !== "SELF") {
        return { name: message.receiver.name, profileUrl: message.receiver.profileUrl };
      }
    }
    throw new Error("Could not identify contact from messages");
  }

  private groupMessagesByDate(
    messages: LinkedInMessage[],
  ): Map<string, LinkedInMessage[]> {
    const grouped = new Map<string, LinkedInMessage[]>();

    for (const message of messages) {
      const date = message.sentAt.split("T")[0];
      logger.info(
        `[DEBUG] Message sentAt: ${message.sentAt}, extracted date: ${date}`,
      );
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date)!.push(message);
    }

    for (const dayMessages of grouped.values()) {
      dayMessages.sort(
        (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
      );
    }

    return grouped;
  }

  private formatDailyMessageBody(messages: LinkedInMessage[]): string {
    let body = "";
    for (const message of messages) {
      const time = new Date(message.sentAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      body += `<p><strong>${message.sender.name}</strong> - `;
      body += `<strong>Time:</strong> ${time}</p>`;
      body += `<p>${message.text.replace(/\n/g, "<br/>")}</p>`;
      body += `<br/>`;
    }
    return body;
  }

  private async getExistingCommunications(
    contactId: string,
  ): Promise<Array<{ id: string; timestamp: string; body: string }>> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/crm/v4/objects/contacts/${contactId}/associations/communications`,
        { headers: this.headers },
      );

      const commIds =
        response.data.results?.map((r: any) => r.toObjectId) || [];
      if (commIds.length === 0) return [];

      const commsResponse = await axios.post(
        `${this.baseUrl}/crm/v3/objects/communications/batch/read`,
        {
          properties: ["hs_communication_body", "hs_timestamp"],
          inputs: commIds.map((id: string) => ({ id })),
        },
        { headers: this.headers },
      );

      logger.warn(
        `[DEBUG] Existing communications response: ${JSON.stringify(commsResponse.data.results, null, 2)}`,
      );

      return (commsResponse.data.results || []).map((comm: any) => ({
        id: comm.id,
        timestamp: comm.properties?.hs_timestamp || "",
        body: comm.properties?.hs_communication_body || "",
      }));
    } catch (error: any) {
      logger.warn(
        `[Messages] Could not fetch existing communications: ${error.message}`,
      );
      return [];
    }
  }

  private async upsertDailyCommunication(
    contactId: string,
    date: string,
    messages: LinkedInMessage[],
    existingId: string | undefined,
    ownerId?: string,
  ): Promise<MessageSyncResult> {
    const firstMessage = messages[0];
    const dayStartTimestamp = `${date}T00:00:00Z`;
    const formattedBody = this.formatDailyMessageBody(messages);

    logger.info(
      `[DEBUG] Processing date: ${date}, dayStartTimestamp: ${dayStartTimestamp}, existingId: ${existingId}`,
    );

    if (existingId) {
      logger.info(
        `[DEBUG] Updating existing communication ${existingId} for date ${date}`,
      );
      await axios.patch(
        `${this.baseUrl}/crm/v3/objects/communications/${existingId}`,
        { properties: { hs_communication_body: formattedBody } },
        { headers: this.headers },
      );
      return {
        id: existingId,
        status: "updated",
        text: `${messages.length} messages on ${date}`,
        timestamp: firstMessage.sentAt,
      };
    }

    const properties: any = {
      hs_communication_channel_type: "LINKEDIN_MESSAGE",
      hs_communication_logged_from: "CRM",
      hs_communication_body: formattedBody,
      hs_timestamp: dayStartTimestamp,
    };
    if (ownerId) properties.hubspot_owner_id = ownerId;

    logger.info(
      `[DEBUG] Creating new communication for date ${date}, payload: ${JSON.stringify({ properties }, null, 2)}`,
    );

    const response = await axios.post(
      `${this.baseUrl}/crm/v3/objects/communications`,
      {
        properties,
        associations: [
          {
            to: { id: contactId },
            types: [
              { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 81 },
            ],
          },
        ],
      },
      { headers: this.headers },
    );

    return {
      id: response.data.id,
      status: "created",
      text: `${messages.length} messages on ${date}`,
      timestamp: firstMessage.sentAt,
    };
  }
}
