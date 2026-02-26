import { Response, NextFunction } from "express";
import { HubSpotSyncService } from "../services/hubspotSyncService";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import { CreateTaskRequest, UpdateTaskRequest } from "../types/hubspot.types";
import prisma from "../config/prisma";

// Get all tasks for a contact
export const getTasks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contactId } = req.query;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const tasks = await hubspotService.getTasksByContact(contactId as string);

    successResponse(res, tasks, "Tasks fetched successfully");
  } catch (error: any) {
    next(error);
  }
};

// Create a new task
export const createTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const taskData: CreateTaskRequest = req.body;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const task = await hubspotService.createTask(
      taskData,
      user.hubspotOwnerId || undefined,
    );

    successResponse(res, task, "Task created successfully", 201);
  } catch (error: any) {
    next(error);
  }
};

// Update an existing task
export const updateTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { taskId } = req.params;
    const taskData: UpdateTaskRequest = req.body;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const task = await hubspotService.updateTask(taskId, taskData);

    successResponse(res, task, "Task updated successfully");
  } catch (error: any) {
    next(error);
  }
};

// Delete a task
export const deleteTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { taskId } = req.params;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    await hubspotService.deleteTask(taskId);

    successResponse(res, null, "Task deleted successfully");
  } catch (error: any) {
    next(error);
  }
};
