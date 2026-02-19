import express, { Application } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import routes from "./routes";
import errorHandler from "./middlewares/errorHandler";
import { requestLogger } from "./middlewares/logger";
import { ALLOWED_ORIGINS, NODE_ENV } from "./config/env";

const app: Application = express();

app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (Postman, mobile apps, curl)
      if (!origin) return callback(null, true);

      // In development, allow all origins
      if (NODE_ENV === "development") return callback(null, true);

      // In production, check whitelist
      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(morgan("combined"));
app.use(requestLogger);

app.get("/", (req, res) => {
  res.json({ message: "Hello World" });
});

app.use("/api", routes);
app.use(errorHandler);

export default app;
