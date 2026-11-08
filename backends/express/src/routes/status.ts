import { Router } from "express";
import { pool, withOrg } from "../db";
import { config } from "../config";
import { keys, redis } from "../redis";
import { notFound } from "../errors";
import { route } from "../http";

export const statusRouter = Router();

/** Public status page. Cached briefly in Redis because it is the endpoint that gets linked and hammered. */
statusRouter.get("/:slug", route(async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const cacheKey = keys.statusCache(slug);
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.set("X-Cache", "HIT").type("application/json").send(cached);
    return;
  }
  const org = (await pool.query<{ id: string; name: string; slug: string }>(
    "SELECT id, name, slug FROM orgs WHERE slug = $1", [slug])).rows[0];
  if (!org) throw notFound("Status page");
  const monitors = await withOrg(org.id, async (db) => (await db.query<{ status: string }>(
    `SELECT m.name, m.status,
            (SELECT round(100.0 * count(*) FILTER (WHERE c.ok) / nullif(count(*), 0), 2)::float8
               FROM check_results c
              WHERE c.monitor_id = m.id AND c.checked_at > now() - interval '24 hours') AS "uptimePercent",
            m.last_checked_at AS "lastCheckedAt"
       FROM monitors m WHERE NOT m.paused ORDER BY m.name, m.id`)).rows);
  const body = JSON.stringify({
    name: org.name,
    slug: org.slug,
    overall: monitors.some((m) => m.status === "down") ? "degraded" : "operational",
    monitors,
    generatedAt: new Date().toISOString(),
  });
  await redis.set(cacheKey, body, "EX", config.cacheTtlSec);
  res.set("X-Cache", "MISS").type("application/json").send(body);
}));
