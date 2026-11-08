import { Router } from "express";
import { withOrg, type Db } from "../db";
import { monitorPatchSchema, newMonitorSchema, type MonitorPatch } from "../domain/schemas";
import { ApiError, notFound } from "../errors";
import { me, requireRole } from "../auth";
import { parse, route, uuidParam } from "../http";

export const MONITOR_COLUMNS = `id, name, url, method, interval_sec AS "intervalSec", timeout_ms AS "timeoutMs",
  expected_status AS "expectedStatus", alert_webhook_url AS "alertWebhookUrl", paused, status,
  last_checked_at AS "lastCheckedAt", created_at AS "createdAt"`;

const PATCH_COLUMNS: Record<keyof MonitorPatch, string> = {
  name: "name", url: "url", method: "method", intervalSec: "interval_sec", timeoutMs: "timeout_ms",
  expectedStatus: "expected_status", alertWebhookUrl: "alert_webhook_url", paused: "paused",
};

export const monitorsRouter = Router();

async function assertMonitor(db: Db, id: string): Promise<void> {
  const { rowCount } = await db.query("SELECT 1 FROM monitors WHERE id = $1", [id]);
  if (!rowCount) throw notFound("Monitor");
}

monitorsRouter.get("/", route(async (req, res) => {
  res.json(await withOrg(me(req).orgId, async (db) =>
    (await db.query(`SELECT ${MONITOR_COLUMNS} FROM monitors ORDER BY created_at DESC, id`)).rows));
}));

monitorsRouter.post("/", requireRole("admin"), route(async (req, res) => {
  const m = parse(newMonitorSchema, req.body);
  const orgId = me(req).orgId;
  const row = await withOrg(orgId, async (db) => (await db.query(
    `INSERT INTO monitors (org_id, name, url, method, interval_sec, timeout_ms, expected_status, alert_webhook_url, paused)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${MONITOR_COLUMNS}`,
    [orgId, m.name, m.url, m.method, m.intervalSec, m.timeoutMs, m.expectedStatus, m.alertWebhookUrl, m.paused])).rows[0]);
  res.status(201).json(row);
}));

monitorsRouter.get("/:id", route(async (req, res) => {
  const id = uuidParam(req.params.id, "Monitor");
  const row = await withOrg(me(req).orgId, async (db) =>
    (await db.query(`SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = $1`, [id])).rows[0]);
  if (!row) throw notFound("Monitor");
  res.json(row);
}));

monitorsRouter.patch("/:id", requireRole("admin"), route(async (req, res) => {
  const id = uuidParam(req.params.id, "Monitor");
  const patch = parse(monitorPatchSchema, req.body);
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [field, column] of Object.entries(PATCH_COLUMNS) as [keyof MonitorPatch, string][]) {
    if (patch[field] === undefined) continue;
    params.push(patch[field]);
    sets.push(`${column} = $${params.length}`);
  }
  // Any change is checked right away, so an edited URL shows its new status quickly.
  sets.push("next_check_at = now()");
  const row = await withOrg(me(req).orgId, async (db) => (await db.query(
    `UPDATE monitors SET ${sets.join(", ")} WHERE id = $1 RETURNING ${MONITOR_COLUMNS}`, params)).rows[0]);
  if (!row) throw notFound("Monitor");
  res.json(row);
}));

monitorsRouter.delete("/:id", requireRole("admin"), route(async (req, res) => {
  const id = uuidParam(req.params.id, "Monitor");
  const deleted = await withOrg(me(req).orgId, async (db) =>
    (await db.query("DELETE FROM monitors WHERE id = $1", [id])).rowCount);
  if (!deleted) throw notFound("Monitor");
  res.status(204).end();
}));

monitorsRouter.post("/:id/check", requireRole("admin"), route(async (req, res) => {
  const id = uuidParam(req.params.id, "Monitor");
  const found = await withOrg(me(req).orgId, async (db) =>
    (await db.query("UPDATE monitors SET next_check_at = now() WHERE id = $1", [id])).rowCount);
  if (!found) throw notFound("Monitor");
  res.status(202).json({ queued: true });
}));

monitorsRouter.get("/:id/checks", route(async (req, res) => {
  const id = uuidParam(req.params.id, "Monitor");
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", "limit: must be an integer from 1 to 500");
  }
  res.json(await withOrg(me(req).orgId, async (db) => {
    await assertMonitor(db, id);
    return (await db.query(
      `SELECT checked_at AS "checkedAt", ok, status_code AS "statusCode", latency_ms AS "latencyMs", error
         FROM check_results WHERE monitor_id = $1 ORDER BY checked_at DESC, id DESC LIMIT $2`, [id, limit])).rows;
  }));
}));

monitorsRouter.get("/:id/stats", route(async (req, res) => {
  const id = uuidParam(req.params.id, "Monitor");
  res.json(await withOrg(me(req).orgId, async (db) => {
    await assertMonitor(db, id);
    const summary = (await db.query(
      `SELECT count(*)::int AS checks,
              (count(*) FILTER (WHERE NOT ok))::int AS failures,
              round(100.0 * count(*) FILTER (WHERE ok) / nullif(count(*), 0), 2)::float8 AS "uptimePercent",
              round(avg(latency_ms))::int AS "avgLatencyMs",
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS "p95LatencyMs"
         FROM check_results WHERE monitor_id = $1 AND checked_at > now() - interval '24 hours'`, [id])).rows[0];
    const hourly = (await db.query(
      `SELECT date_trunc('hour', checked_at) AS hour, count(*)::int AS checks,
              (count(*) FILTER (WHERE NOT ok))::int AS failures, round(avg(latency_ms))::int AS "avgLatencyMs"
         FROM check_results WHERE monitor_id = $1 AND checked_at > now() - interval '24 hours'
        GROUP BY 1 ORDER BY 1`, [id])).rows;
    return { ...summary, hourly };
  }));
}));
