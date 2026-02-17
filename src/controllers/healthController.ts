import { Request, Response } from "express";
import { successResponse } from "../utils/apiResponse";
import { HealthData } from "../types";

export const getHealth = (req: Request, res: Response): void => {
  const healthData: HealthData = {
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
  };

  successResponse(res, healthData, "Server is healthy");
};
