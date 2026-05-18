import axios from "axios";
import { CreateTaskRequest, UpdateTaskRequest, TaskResponse, TaskItem, ContactListItem } from "../types";
import logger from "../utils/logger";
import {
  getOwnerById,
  mapPriorityToHubSpot,
  mapPriorityFromHubSpot,
  mapStatusToHubSpot,
  convertLocalTimeToUTC,
  parseHubSpotDateTime,
} from "./hubspotHelpers";

export class HubSpotTaskService {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string>,
  ) {}

  async getTasksByContact(contactId: string, userTimeZone?: string): Promise<TaskResponse[]> {
    const response = await axios.get(
      `${this.baseUrl}/crm/v4/objects/contacts/${contactId}/associations/tasks`,
      { headers: this.headers },
    );

    const taskIds = response.data.results?.map((r: any) => r.toObjectId) || [];
    if (taskIds.length === 0) return [];

    const tasksResponse = await axios.post(
      `${this.baseUrl}/crm/v3/objects/tasks/batch/read`,
      {
        properties: [
          "hs_task_subject",
          "hs_task_body",
          "hs_task_priority",
          "hs_task_status",
          "hubspot_owner_id",
          "hs_timestamp",
          "hs_task_reminders",
        ],
        inputs: taskIds.map((id: string) => ({ id })),
      },
      { headers: this.headers },
    );

    return Promise.all(
      (tasksResponse.data.results || []).map(async (task: any) => {
        const props = task.properties;
        const { dueDate, time } = parseHubSpotDateTime(props.hs_timestamp, userTimeZone);

        const assignedTo = props.hubspot_owner_id
          ? await getOwnerById(props.hubspot_owner_id, this.baseUrl, this.headers)
          : null;

        const reminderKey =
          props.hs_task_reminders && props.hs_timestamp
            ? this.matchReminderKey(Number(props.hs_task_reminders), new Date(props.hs_timestamp).getTime())
            : null;
        let reminderCustomDate: string | null = null;
        let reminderCustomTime: string | null = null;
        if (reminderKey === "custom" && props.hs_task_reminders) {
          const parsed = parseHubSpotDateTime(new Date(Number(props.hs_task_reminders)).toISOString(), userTimeZone);
          reminderCustomDate = parsed.dueDate;
          reminderCustomTime = parsed.time;
        }

        return {
          id: task.id,
          taskName: props.hs_task_subject || "",
          dueDate,
          time,
          priority: mapPriorityFromHubSpot(props.hs_task_priority),
          status: props.hs_task_status || "NOT_STARTED",
          assignedTo: assignedTo || null,
          comment: props.hs_task_body || null,
          reminder: reminderKey,
          reminderCustomDate,
          reminderCustomTime,
          timestamp: task.createdAt,
        };
      }),
    );
  }

  async getTasksByContactPaginated(
    contactId: string,
    options: { limit?: number; after?: string } = {},
    userTimeZone?: string,
  ): Promise<{ tasks: TaskResponse[]; hasMore: boolean; nextCursor: string | null }> {
    const limit = Math.min(50, options.limit ?? 20);

    const url = new URL(`${this.baseUrl}/crm/v4/objects/contacts/${contactId}/associations/tasks`);
    url.searchParams.set("limit", String(limit));
    if (options.after) url.searchParams.set("after", options.after);

    const assocResponse = await axios.get(url.toString(), { headers: this.headers });

    const taskIds: string[] = assocResponse.data.results?.map((r: any) => String(r.toObjectId)) ?? [];
    const nextCursor: string | null = assocResponse.data.paging?.next?.after ?? null;
    const hasMore = nextCursor !== null;

    if (taskIds.length === 0) return { tasks: [], hasMore, nextCursor };

    const tasksResponse = await axios.post(
      `${this.baseUrl}/crm/v3/objects/tasks/batch/read`,
      {
        properties: ["hs_task_subject", "hs_task_body", "hs_task_priority", "hs_task_status", "hubspot_owner_id", "hs_timestamp", "hs_task_reminders"],
        inputs: taskIds.map((id) => ({ id })),
      },
      { headers: this.headers },
    );

    const tasks = await Promise.all(
      (tasksResponse.data.results || []).map(async (task: any) => {
        const props = task.properties;
        const { dueDate, time } = parseHubSpotDateTime(props.hs_timestamp, userTimeZone);
        const assignedTo = props.hubspot_owner_id
          ? await getOwnerById(props.hubspot_owner_id, this.baseUrl, this.headers)
          : null;
        const reminderKey =
          props.hs_task_reminders && props.hs_timestamp
            ? this.matchReminderKey(Number(props.hs_task_reminders), new Date(props.hs_timestamp).getTime())
            : null;
        let reminderCustomDate: string | null = null;
        let reminderCustomTime: string | null = null;
        if (reminderKey === "custom" && props.hs_task_reminders) {
          const parsed = parseHubSpotDateTime(new Date(Number(props.hs_task_reminders)).toISOString(), userTimeZone);
          reminderCustomDate = parsed.dueDate;
          reminderCustomTime = parsed.time;
        }
        return {
          id: task.id,
          taskName: props.hs_task_subject || "",
          dueDate,
          time,
          priority: mapPriorityFromHubSpot(props.hs_task_priority),
          status: props.hs_task_status || "NOT_STARTED",
          assignedTo: assignedTo || null,
          comment: props.hs_task_body || null,
          reminder: reminderKey,
          reminderCustomDate,
          reminderCustomTime,
          timestamp: task.createdAt,
        };
      }),
    );

    return { tasks, hasMore, nextCursor };
  }

  async createTask(
    data: CreateTaskRequest,
    ownerId?: string,
  ): Promise<TaskResponse> {
    const properties: any = {
      hs_task_subject: data.taskName,
      hs_task_priority: mapPriorityToHubSpot(data.priority),
      hs_task_status: mapStatusToHubSpot(data.status),
    };

    if (data.dueDate) {
      properties.hs_timestamp = convertLocalTimeToUTC(
        data.dueDate,
        data.time || "00:00",
        data.userTimeZone,
      );
    }
    if (data.reminder === "custom" && data.reminderCustomDatetime) {
      properties.hs_task_reminders = new Date(data.reminderCustomDatetime).getTime();
    } else if (data.reminder && data.reminder !== "none" && properties.hs_timestamp) {
      const reminderMs = this.computeReminderMs(data.reminder, properties.hs_timestamp);
      if (reminderMs !== null) properties.hs_task_reminders = reminderMs;
    }

    const validationError = this.validateTimestamps(
      properties.hs_timestamp,
      properties.hs_task_reminders !== undefined ? Number(properties.hs_task_reminders) : undefined,
      true,
    );
    if (validationError) throw Object.assign(new Error(validationError), { statusCode: 400 });

    if (data.comment) properties.hs_task_body = data.comment;
    properties.hubspot_owner_id = data.assignedTo || ownerId || undefined;

    const payload: any = { properties };

    if (data.contactId) {
      payload.associations = [
        {
          to: { id: data.contactId },
          types: [
            { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 },
          ],
        },
      ];
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/tasks`,
        payload,
        { headers: this.headers },
      );

      const task = response.data;
      const { dueDate, time } = parseHubSpotDateTime(
        task.properties.hs_timestamp,
        data.userTimeZone,
      );

      const assignedTo = task.properties.hubspot_owner_id
        ? await getOwnerById(task.properties.hubspot_owner_id, this.baseUrl, this.headers)
        : null;

      const reminderCreateKey =
        task.properties.hs_task_reminders && task.properties.hs_timestamp
          ? this.matchReminderKey(Number(task.properties.hs_task_reminders), new Date(task.properties.hs_timestamp).getTime())
          : null;
      let reminderCreateCustomDate: string | null = null;
      let reminderCreateCustomTime: string | null = null;
      if (reminderCreateKey === "custom" && task.properties.hs_task_reminders) {
        const parsed = parseHubSpotDateTime(new Date(Number(task.properties.hs_task_reminders)).toISOString(), data.userTimeZone);
        reminderCreateCustomDate = parsed.dueDate;
        reminderCreateCustomTime = parsed.time;
      }

      return {
        id: task.id,
        taskName: task.properties.hs_task_subject,
        dueDate,
        time,
        priority: mapPriorityFromHubSpot(task.properties.hs_task_priority),
        status: task.properties.hs_task_status,
        assignedTo: assignedTo || null,
        comment: task.properties.hs_task_body || null,
        reminder: reminderCreateKey,
        reminderCustomDate: reminderCreateCustomDate,
        reminderCustomTime: reminderCreateCustomTime,
        timestamp: task.createdAt,
      };
    } catch (error: any) {
      logger.error(`[HubSpot] Task creation failed: ${error.message}`);
      logger.error(
        `[HubSpot] Response: ${JSON.stringify(error.response?.data)}`,
      );
      throw new Error(
        `Task creation failed: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  async updateTask(
    taskId: string,
    data: UpdateTaskRequest,
  ): Promise<TaskResponse> {
    const properties: any = {
      hs_task_subject: data.taskName,
      hs_task_priority: mapPriorityToHubSpot(data.priority),
      hs_task_status: mapStatusToHubSpot(data.status),
      hubspot_owner_id: data.assignedTo,
    };

    if (data.dueDate) {
      properties.hs_timestamp = convertLocalTimeToUTC(
        data.dueDate,
        data.time || "00:00",
        data.userTimeZone,
      );
    }
    if (data.reminder === "custom" && data.reminderCustomDatetime) {
      properties.hs_task_reminders = new Date(data.reminderCustomDatetime).getTime();
    } else if (data.reminder && data.reminder !== "none" && properties.hs_timestamp) {
      const reminderMs = this.computeReminderMs(data.reminder, properties.hs_timestamp);
      if (reminderMs !== null) properties.hs_task_reminders = reminderMs;
    } else if (data.reminder === "none") {
      properties.hs_task_reminders = "";
    }

    const validationError = this.validateTimestamps(
      properties.hs_timestamp,
      properties.hs_task_reminders !== undefined && properties.hs_task_reminders !== ""
        ? Number(properties.hs_task_reminders) : undefined,
      false,
    );
    if (validationError) throw Object.assign(new Error(validationError), { statusCode: 400 });

    if (data.comment !== undefined) properties.hs_task_body = data.comment;

    await axios.patch(
      `${this.baseUrl}/crm/v3/objects/tasks/${taskId}`,
      { properties },
      { headers: this.headers },
    );

    const response = await axios.get(
      `${this.baseUrl}/crm/v3/objects/tasks/${taskId}`,
      {
        params: {
          properties:
            "hs_task_subject,hs_task_body,hs_task_priority,hs_task_status,hubspot_owner_id,hs_timestamp,hs_task_reminders",
        },
        headers: this.headers,
      },
    );

    const task = response.data;
    const { dueDate, time } = parseHubSpotDateTime(task.properties.hs_timestamp, data.userTimeZone);

    const assignedTo = task.properties.hubspot_owner_id
      ? await getOwnerById(task.properties.hubspot_owner_id, this.baseUrl, this.headers)
      : null;

    const reminderUpdateKey =
      task.properties.hs_task_reminders && task.properties.hs_timestamp
        ? this.matchReminderKey(Number(task.properties.hs_task_reminders), new Date(task.properties.hs_timestamp).getTime())
        : null;
    let reminderUpdateCustomDate: string | null = null;
    let reminderUpdateCustomTime: string | null = null;
    if (reminderUpdateKey === "custom" && task.properties.hs_task_reminders) {
      const parsed = parseHubSpotDateTime(new Date(Number(task.properties.hs_task_reminders)).toISOString(), data.userTimeZone);
      reminderUpdateCustomDate = parsed.dueDate;
      reminderUpdateCustomTime = parsed.time;
    }

    return {
      id: task.id,
      taskName: task.properties.hs_task_subject,
      dueDate,
      time,
      priority: mapPriorityFromHubSpot(task.properties.hs_task_priority),
      status: task.properties.hs_task_status,
      assignedTo: assignedTo || null,
      comment: task.properties.hs_task_body || null,
      reminder: reminderUpdateKey,
      reminderCustomDate: reminderUpdateCustomDate,
      reminderCustomTime: reminderUpdateCustomTime,
      timestamp: task.updatedAt,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    await axios.delete(`${this.baseUrl}/crm/v3/objects/tasks/${taskId}`, {
      headers: this.headers,
    });
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  private readonly REMINDER_OFFSETS: Record<string, number> = {
    at_time: 0,
    "15min": 900000,
    "30min": 1800000,
    "1hour": 3600000,
    "2hours": 7200000,
    "1day": 86400000,
    "1week": 604800000,
  };

  private computeReminderMs(reminder: string, dueIsoString: string): number | null {
    const offset = this.REMINDER_OFFSETS[reminder];
    if (offset === undefined) return null;
    return new Date(dueIsoString).getTime() - offset;
  }

  private matchReminderKey(reminderMs: number, dueMs: number): string {
    const offset = dueMs - reminderMs;
    for (const [key, val] of Object.entries(this.REMINDER_OFFSETS)) {
      if (Math.abs(offset - val) < 60000) return key;
    }
    return "custom";
  }

  private validateTimestamps(dueIso: string | undefined, reminderMs: number | undefined, isCreate: boolean): string | null {
    const now = Date.now() - 300000; // 5-min grace window
    if (isCreate && dueIso && new Date(dueIso).getTime() < now)
      return "Due date cannot be in the past";
    if (reminderMs !== undefined && reminderMs < now)
      return "Reminder time cannot be in the past";
    return null;
  }

  // Fetch ALL tasks for the given contacts in two parallelised batch rounds.
  // Round 1: contact IDs → task IDs  (contacts/tasks associations, 100 contacts/call)
  // Round 2: task IDs   → task bodies (tasks batch/read,            100 tasks/call)
  // Owner names resolved in a single GET /crm/v3/owners call.
  async getAllTasksByContacts(contacts: ContactListItem[], userTimeZone = "UTC"): Promise<TaskItem[]> {
    if (contacts.length === 0) return [];

    const contactInfoMap = new Map(
      contacts.map((c) => [c.id, { name: c.name, company: c.company }]),
    );
    const contactIds = contacts.map((c) => c.id);

    // Round 1: contacts → task IDs (parallel, 100 contacts per call)
    const assocChunks = this.chunkArray(contactIds, 100);
    const assocResponses = await Promise.all(
      assocChunks.map((ids) =>
        axios
          .post(
            `${this.baseUrl}/crm/v4/associations/contacts/tasks/batch/read`,
            { inputs: ids.map((id) => ({ id })) },
            { headers: this.headers },
          )
          .catch((err) => {
            logger.warn(`[HubSpot] contacts→tasks assoc chunk failed: ${err.message}`);
            return { data: { results: [] } };
          }),
      ),
    );

    const taskContactMap = new Map<string, string>(); // taskId → contactId
    for (const res of assocResponses) {
      for (const r of res.data?.results ?? []) {
        const contactId = String(r.from.id);
        for (const t of r.to ?? []) {
          taskContactMap.set(String(t.toObjectId), contactId);
        }
      }
    }

    const allTaskIds = [...taskContactMap.keys()];
    if (allTaskIds.length === 0) return [];

    // Round 2: task IDs → task bodies (parallel, 100 tasks per call)
    const taskChunks = this.chunkArray(allTaskIds, 100);
    const [taskResponses, ownersRes] = await Promise.all([
      Promise.all(
        taskChunks.map((ids) =>
          axios
            .post(
              `${this.baseUrl}/crm/v3/objects/tasks/batch/read`,
              {
                properties: [
                  "hs_task_subject",
                  "hs_task_body",
                  "hs_task_priority",
                  "hs_task_status",
                  "hubspot_owner_id",
                  "hs_timestamp",
                  "hs_task_reminders",
                ],
                inputs: ids.map((id) => ({ id })),
              },
              { headers: this.headers },
            )
            .catch((err) => {
              logger.warn(`[HubSpot] tasks batch/read chunk failed: ${err.message}`);
              return { data: { results: [] } };
            }),
        ),
      ),
      // Owner resolution: 1 call to get all owners
      axios
        .get(`${this.baseUrl}/crm/v3/owners`, { headers: this.headers })
        .catch((err) => {
          logger.warn(`[HubSpot] Could not fetch owners: ${err.message}`);
          return { data: { results: [] } };
        }),
    ]);

    const ownerMap = new Map<string, string>(); // ownerId → ownerName
    for (const o of ownersRes.data?.results ?? []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || "";
      if (o.id) ownerMap.set(String(o.id), name);
    }

    const tasks: TaskItem[] = [];
    for (const res of taskResponses) {
      for (const t of res.data?.results ?? []) {
        const contactId = taskContactMap.get(t.id);
        if (!contactId) continue; // orphan — skip

        const props = t.properties;
        const { dueDate, time } = parseHubSpotDateTime(props.hs_timestamp, userTimeZone);
        const info = contactInfoMap.get(contactId);

        const reminderAllKey =
          props.hs_task_reminders && props.hs_timestamp
            ? this.matchReminderKey(Number(props.hs_task_reminders), new Date(props.hs_timestamp).getTime())
            : null;
        let reminderAllCustomDate: string | null = null;
        let reminderAllCustomTime: string | null = null;
        if (reminderAllKey === "custom" && props.hs_task_reminders) {
          const parsed = parseHubSpotDateTime(new Date(Number(props.hs_task_reminders)).toISOString(), userTimeZone);
          reminderAllCustomDate = parsed.dueDate;
          reminderAllCustomTime = parsed.time;
        }

        tasks.push({
          id: t.id,
          taskName: props.hs_task_subject || "",
          dueDate,
          time,
          priority: mapPriorityFromHubSpot(props.hs_task_priority),
          status: props.hs_task_status || "NOT_STARTED",
          assignedTo: props.hubspot_owner_id ? (ownerMap.get(props.hubspot_owner_id) || null) : null,
          comment: props.hs_task_body || null,
          reminder: reminderAllKey,
          reminderCustomDate: reminderAllCustomDate,
          reminderCustomTime: reminderAllCustomTime,
          timestamp: props.hs_timestamp || t.createdAt,
          contactId,
          contactName: info?.name,
          contactCompany: info?.company,
        });
      }
    }

    tasks.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return tasks;
  }
}
