import express, { Application } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import routes from "./routes";
import errorHandler from "./middlewares/errorHandler";
import { requestLogger } from "./middlewares/logger";

const app: Application = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("combined"));
app.use(requestLogger);

app.use("/api", routes);

app.use(errorHandler);

export default app;
