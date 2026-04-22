import axios from "axios";
import { CreateTaskRequest, UpdateTaskRequest, TaskResponse } from "../types";
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

  async getTasksByContact(contactId: string): Promise<TaskResponse[]> {
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
        ],
        inputs: taskIds.map((id: string) => ({ id })),
      },
      { headers: this.headers },
    );

    return Promise.all(
      (tasksResponse.data.results || []).map(async (task: any) => {
        const props = task.properties;
        const { dueDate, time } = parseHubSpotDateTime(props.hs_timestamp);

        const assignedTo = props.hubspot_owner_id
          ? await getOwnerById(props.hubspot_owner_id, this.baseUrl, this.headers)
          : null;

        return {
          id: task.id,
          taskName: props.hs_task_subject || "",
          dueDate,
          time,
          priority: mapPriorityFromHubSpot(props.hs_task_priority),
          status: props.hs_task_status || "NOT_STARTED",
          assignedTo: assignedTo || null,
          comment: props.hs_task_body || null,
          timestamp: task.createdAt,
        };
      }),
    );
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
      );
    }
    if (data.comment) properties.hs_task_body = data.comment;
    if (ownerId) properties.hubspot_owner_id = ownerId;

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
      );

      const assignedTo = task.properties.hubspot_owner_id
        ? await getOwnerById(task.properties.hubspot_owner_id, this.baseUrl, this.headers)
        : null;

      return {
        id: task.id,
        taskName: task.properties.hs_task_subject,
        dueDate,
        time,
        priority: mapPriorityFromHubSpot(task.properties.hs_task_priority),
        status: task.properties.hs_task_status,
        assignedTo: assignedTo || null,
        comment: task.properties.hs_task_body || null,
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
      );
    }
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
            "hs_task_subject,hs_task_body,hs_task_priority,hs_task_status,hubspot_owner_id,hs_timestamp",
        },
        headers: this.headers,
      },
    );

    const task = response.data;
    const { dueDate, time } = parseHubSpotDateTime(task.properties.hs_timestamp);

    const assignedTo = task.properties.hubspot_owner_id
      ? await getOwnerById(task.properties.hubspot_owner_id, this.baseUrl, this.headers)
      : null;

    return {
      id: task.id,
      taskName: task.properties.hs_task_subject,
      dueDate,
      time,
      priority: mapPriorityFromHubSpot(task.properties.hs_task_priority),
      status: task.properties.hs_task_status,
      assignedTo: assignedTo || null,
      comment: task.properties.hs_task_body || null,
      timestamp: task.updatedAt,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    await axios.delete(`${this.baseUrl}/crm/v3/objects/tasks/${taskId}`, {
      headers: this.headers,
    });
  }
}
