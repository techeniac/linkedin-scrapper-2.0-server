import express, { Application } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import routes from "./routes";
import errorHandler from "./middlewares/errorHandler";
import { requestLogger } from "./middlewares/logger";

// Initialize Express application
const app: Application = express();

// Security middleware - sets various HTTP headers
app.use(helmet());

// Enable CORS for all routes
app.use(cors());

// Parse JSON request bodies
app.use(express.json());

// Parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// HTTP request logger
app.use(morgan("combined"));

// Custom request logger middleware
app.use(requestLogger);

// Mount API routes
app.use("/api", routes);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
