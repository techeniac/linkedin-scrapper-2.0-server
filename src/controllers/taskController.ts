import { Response, NextFunction } from "express";
import { HubSpotContextService } from "../services/hubspotContextService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest, CreateTaskRequest, UpdateTaskRequest } from "../types";

export const getTasks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contactId, userTimeZone, after } = req.query;
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const { syncService } = await HubSpotContextService.getContext(req.user!.id);
    const result = await syncService.getTasksByContactPaginated(
      contactId as string,
      { limit, after: after as string | undefined },
      userTimeZone as string | undefined,
    );
    successResponse(res, result, "Tasks fetched successfully");
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
  } catch (error: any) {
    if (error.statusCode === 400) {
      errorResponse(res, error.message, 400);
    } else {
      next(error);
    }
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
  } catch (error: any) {
    if (error.statusCode === 400) {
      errorResponse(res, error.message, 400);
    } else {
      next(error);
    }
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
