import express from "express";
import { pool } from "./db";
import { redis } from "./redis";
import { errorHandler, notFound } from "./errors";
import { route } from "./http";
import { registry } from "./metrics";
import { requireAuth } from "./auth";
import { authRouter, meRouter } from "./routes/auth";
import { orgRouter } from "./routes/org";
import { monitorsRouter } from "./routes/monitors";
import { activityRouter } from "./routes/activity";
import { statusRouter } from "./routes/status";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "100kb" }));

  // Scraped by Prometheus straight from each replica; nginx does not proxy it.
  app.get("/metrics", route(async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  }));

  const api = express.Router();
  api.get("/health", route(async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      res.json({ status: "ok", backend: "express" });
    } catch {
      res.status(503).json({ status: "degraded", backend: "express" });
    }
  }));
  api.use("/auth", authRouter);
  api.use("/status", statusRouter);
  // Everything below needs a JWT or an API key (authenticated once per request).
  api.use(requireAuth);
  api.use("/me", meRouter);
  api.use("/monitors", monitorsRouter);
  api.use(orgRouter);
  api.use(activityRouter);
  api.use((_req, _res, next) => next(notFound("Route")));

  app.use("/api", api);
  app.use(errorHandler);
  return app;
}
