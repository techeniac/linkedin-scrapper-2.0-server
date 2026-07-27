import { Response, NextFunction } from "express";
import { HubSpotContextService } from "../services/hubspotContextService";
import { successResponse } from "../utils/apiResponse";
import { AuthRequest, CreateTaskRequest, UpdateTaskRequest } from "../types";

export const getTasks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contactId, userTimeZone } = req.query;
    const { syncService } = await HubSpotContextService.getContext(req.user!.id);
    const tasks = await syncService.getTasksByContact(contactId as string, userTimeZone as string | undefined);
    successResponse(res, tasks, "Tasks fetched successfully");
  } catch (error) {
    next(error);
  }
};

export const createTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const taskData: CreateTaskRequest = req.body;
    const { syncService, ownerId } = await HubSpotContextService.getContext(req.user!.id);
    const task = await syncService.createTask(taskData, ownerId);
    successResponse(res, task, "Task created successfully", 201);
  } catch (error) {
    next(error);
  }
};

export const updateTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { taskId } = req.params;
    const taskData: UpdateTaskRequest = req.body;
    const { syncService } = await HubSpotContextService.getContext(req.user!.id);
    const task = await syncService.updateTask(taskId, taskData);
    successResponse(res, task, "Task updated successfully");
  } catch (error) {
    next(error);
  }
};

export const deleteTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { taskId } = req.params;
    const { syncService } = await HubSpotContextService.getContext(req.user!.id);
    await syncService.deleteTask(taskId);
    successResponse(res, null, "Task deleted successfully");
  } catch (error) {
    next(error);
  }
};
