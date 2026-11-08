import { Router } from "express";
import bcrypt from "bcryptjs";
import { isUniqueViolation, pool, withOrg } from "../db";
import { newApiKeySchema, newMemberSchema } from "../domain/schemas";
import { newApiKey } from "../domain/rules";
import { ApiError, notFound } from "../errors";
import { hasRole, me, requireRole, requireUser } from "../auth";
import { parse, route, uuidParam } from "../http";

export const orgRouter = Router();

orgRouter.get("/org", route(async (req, res) => {
  const p = me(req);
  const { rows } = await pool.query(
    `SELECT id, name, slug, created_at AS "createdAt", webhook_secret AS "webhookSecret" FROM orgs WHERE id = $1`, [p.orgId]);
  if (!rows[0]) throw notFound("Organisation");
  if (!hasRole(p, "admin")) delete rows[0].webhookSecret;
  res.json(rows[0]);
}));

// Members live in users, which has no row-level security (login looks users up across orgs),
// so these queries filter on org_id explicitly.
const MEMBER_COLUMNS = `id, email, role, created_at AS "createdAt"`;

orgRouter.get("/members", route(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${MEMBER_COLUMNS} FROM users WHERE org_id = $1 ORDER BY created_at, id`, [me(req).orgId]);
  res.json(rows);
}));

orgRouter.post("/members", requireRole("owner"), route(async (req, res) => {
  const { email, password, role } = parse(newMemberSchema, req.body);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${MEMBER_COLUMNS}`,
      [me(req).orgId, email, await bcrypt.hash(password, 10), role]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered");
    throw err;
  }
}));

const KEY_COLUMNS = `id, name, prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

orgRouter.get("/api-keys", requireUser, requireRole("admin"), route(async (req, res) => {
  const rows = await withOrg(me(req).orgId, async (db) =>
    (await db.query(`SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC, id`)).rows);
  res.json(rows);
}));

orgRouter.post("/api-keys", requireUser, requireRole("admin"), route(async (req, res) => {
  const { name } = parse(newApiKeySchema, req.body);
  const p = me(req);
  const { key, prefix, hash } = newApiKey();
  const row = await withOrg(p.orgId, async (db) => (await db.query(
    `INSERT INTO api_keys (org_id, name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${KEY_COLUMNS}`,
    [p.orgId, name, prefix, hash, p.kind === "user" ? p.userId : null])).rows[0]);
  res.status(201).json({ ...row, key });
}));

orgRouter.delete("/api-keys/:id", requireUser, requireRole("admin"), route(async (req, res) => {
  const id = uuidParam(req.params.id, "API key");
  const found = await withOrg(me(req).orgId, async (db) => (await db.query(
    "UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", [id])).rowCount);
  if (!found) throw notFound("API key");
  res.status(204).end();
}));
