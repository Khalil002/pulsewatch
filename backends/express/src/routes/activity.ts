import { Router } from "express";
import { withOrg } from "../db";
import { ApiError } from "../errors";
import { me } from "../auth";
import { isUuid, route } from "../http";

export const activityRouter = Router();

function monitorFilter(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isUuid(value)) throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", "monitorId: must be a UUID");
  return value;
}

activityRouter.get("/incidents", route(async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && status !== "open" && status !== "resolved") {
    throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", "status: must be open or resolved");
  }
  const monitorId = monitorFilter(req.query.monitorId);
  res.json(await withOrg(me(req).orgId, async (db) => (await db.query(
    `SELECT i.id, i.monitor_id AS "monitorId", m.name AS "monitorName", i.started_at AS "startedAt",
            i.resolved_at AS "resolvedAt", i.cause
       FROM incidents i JOIN monitors m ON m.id = i.monitor_id
      WHERE ($1::text IS NULL OR ($1::text = 'open') = (i.resolved_at IS NULL))
        AND ($2::uuid IS NULL OR i.monitor_id = $2::uuid)
      ORDER BY i.started_at DESC, i.id LIMIT 100`, [status ?? null, monitorId])).rows));
}));

activityRouter.get("/alerts", route(async (req, res) => {
  const monitorId = monitorFilter(req.query.monitorId);
  res.json(await withOrg(me(req).orgId, async (db) => (await db.query(
    `SELECT id, monitor_id AS "monitorId", event, status, attempts, last_error AS "lastError",
            created_at AS "createdAt", sent_at AS "sentAt"
       FROM alert_jobs WHERE ($1::uuid IS NULL OR monitor_id = $1::uuid)
      ORDER BY created_at DESC, id LIMIT 100`, [monitorId])).rows));
}));
