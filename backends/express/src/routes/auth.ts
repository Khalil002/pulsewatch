import { Router } from "express";
import bcrypt from "bcryptjs";
import { isUniqueViolation, pool, withTransaction } from "../db";
import { registrationSchema } from "../domain/schemas";
import { orgSlug } from "../domain/rules";
import { ApiError, forbidden, notFound } from "../errors";
import { issueToken, me, type UserClaims } from "../auth";
import { parse, route } from "../http";

const USER_COLUMNS = `id, email, role, org_id AS "orgId"`;

export const authRouter = Router();

authRouter.post("/register", route(async (req, res) => {
  const { email, password, orgName } = parse(registrationSchema, req.body);
  const hash = await bcrypt.hash(password, 10);
  try {
    const user = await withTransaction(async (db) => {
      const taken = await db.query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
      if (taken.rowCount) throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered");
      // The random suffix makes a slug clash unlikely; retry a few times if one happens.
      let orgId: string | undefined;
      for (let attempt = 0; !orgId; attempt++) {
        const { rows } = await db.query<{ id: string }>(
          "INSERT INTO orgs (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING id",
          [orgName, orgSlug(orgName)]);
        orgId = rows[0]?.id;
        if (!orgId && attempt >= 4) throw new Error("could not allocate an org slug");
      }
      const { rows } = await db.query<UserClaims>(
        `INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING ${USER_COLUMNS}`,
        [orgId, email, hash]);
      return rows[0];
    });
    res.status(201).json({ token: issueToken(user), user });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered");
    throw err;
  }
}));

authRouter.post("/login", route(async (req, res) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const { rows } = await pool.query<UserClaims & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = $1`, [email]);
  const found = rows[0];
  if (!found || !(await bcrypt.compare(password, found.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  const { password_hash: _, ...user } = found;
  res.json({ token: issueToken(user), user });
}));

export const meRouter = Router();

meRouter.get("/", route(async (req, res) => {
  const p = me(req);
  if (p.kind !== "user") throw forbidden("API keys have no user");
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [p.userId]);
  if (!rows[0]) throw notFound("User");
  res.json(rows[0]);
}));
