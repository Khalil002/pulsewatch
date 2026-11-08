import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { pool } from "./db";
import { redis, keys } from "./redis";
import { ApiError, forbidden } from "./errors";
import { sha256Hex } from "./domain/rules";

export type Role = "owner" | "admin" | "viewer";
export interface UserClaims { id: string; email: string; role: Role; orgId: string }

/** Who is calling: a signed-in user, or an API key (which acts as an admin of its org). */
export type Principal =
  | { kind: "user"; userId: string; email: string; orgId: string; role: Role }
  | { kind: "key"; keyId: string; orgId: string; role: "admin" };

declare module "express-serve-static-core" {
  interface Request { principal?: Principal }
}

const ISSUER = "pulsewatch";

/** HS256 token with the claims every backend reads: sub, email, role, org. */
export function issueToken(user: UserClaims): string {
  return jwt.sign({ email: user.email, role: user.role, org: user.orgId }, config.jwtSecret, {
    algorithm: "HS256", subject: user.id, issuer: ISSUER, expiresIn: config.jwtTtlSec,
  });
}

function verifyToken(token: string | undefined): Principal | undefined {
  if (!token) return undefined;
  try {
    const c = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER }) as jwt.JwtPayload;
    return { kind: "user", userId: String(c.sub), email: String(c.email), orgId: String(c.org), role: c.role as Role };
  } catch {
    return undefined;
  }
}

/** Fixed-window counter per key, shared by every replica through Redis. */
async function rateLimit(keyId: string): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / config.rateLimitWindowSec);
  const key = keys.rateLimit(keyId, window);
  const [[, count]] = (await redis.multi().incr(key).expire(key, config.rateLimitWindowSec, "NX").exec()) as [[null, number]];
  if (count > config.rateLimitMax) {
    const retryAfter = (window + 1) * config.rateLimitWindowSec - Math.floor(Date.now() / 1000);
    throw new ApiError(429, "RATE_LIMITED", "Too many requests for this API key",
      `limit is ${config.rateLimitMax} per ${config.rateLimitWindowSec}s`, { "Retry-After": String(Math.max(1, retryAfter)) });
  }
}

async function authenticate(req: Request): Promise<Principal> {
  const apiKey = req.header("x-api-key");
  if (apiKey) {
    const { rows } = await pool.query<{ key_id: string; key_org_id: string }>(
      "SELECT key_id, key_org_id FROM api_key_lookup($1)", [sha256Hex(apiKey)]);
    if (!rows[0]) throw new ApiError(401, "UNAUTHORIZED", "Invalid or revoked API key");
    await rateLimit(rows[0].key_id);
    return { kind: "key", keyId: rows[0].key_id, orgId: rows[0].key_org_id, role: "admin" };
  }
  const [scheme, token] = (req.header("authorization") ?? "").split(" ");
  const principal = scheme?.toLowerCase() === "bearer" ? verifyToken(token) : undefined;
  if (!principal) throw new ApiError(401, "UNAUTHORIZED", "Missing, invalid or expired credentials");
  return principal;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  authenticate(req).then((p) => { req.principal = p; next(); }, next);
}

const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

export const hasRole = (p: Principal, min: Role) => RANK[p.role] >= RANK[min];

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) =>
    next(hasRole(req.principal!, min) ? undefined : forbidden(`requires the ${min} role`));
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  next(req.principal?.kind === "user" ? undefined : forbidden("API keys cannot do this; sign in instead"));
}

export const me = (req: Request) => req.principal!;
