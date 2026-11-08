import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

// Rules every backend implements identically. The unit tests in each backend pin the same values.

export type MonitorStatus = "pending" | "up" | "down";

export const MAX_ALERT_ATTEMPTS = 5;
/** Seconds to wait before retrying a delivery that has failed `attempts` times. */
export const backoffSeconds = (attempts: number): number => 2 ** attempts;

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** "Acme Corp!" -> "acme-corp". Non-ASCII letters are dropped; an empty result becomes "org". */
export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return base || "org";
}

/** Public slug: slugified name plus 4 random characters, so names don't have to be unique. */
export const orgSlug = (name: string): string =>
  `${slugify(name)}-${Array.from({ length: 4 }, () => SLUG_CHARS[randomInt(SLUG_CHARS.length)]).join("")}`;

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** API keys look like pw_ + 48 hex chars. Only the SHA-256 is stored; the prefix helps people tell keys apart. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `pw_${randomBytes(24).toString("hex")}`;
  return { key, prefix: key.slice(0, 10), hash: sha256Hex(key) };
}

/** Value of the X-Pulsewatch-Signature header for a raw webhook body. */
export const signature = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

export interface CheckOutcome { ok: boolean; statusCode: number | null; latencyMs: number; error: string | null }

export const responseOutcome = (statusCode: number, expected: number, latencyMs: number): CheckOutcome => ({
  ok: statusCode === expected,
  statusCode,
  latencyMs,
  error: statusCode === expected ? null : `expected ${expected} but got ${statusCode}`,
});

export const timeoutOutcome = (timeoutMs: number, latencyMs: number): CheckOutcome =>
  ({ ok: false, statusCode: null, latencyMs, error: `timeout after ${timeoutMs} ms` });

export const connectionOutcome = (reason: string, latencyMs: number): CheckOutcome =>
  ({ ok: false, statusCode: null, latencyMs, error: `connection failed: ${reason}` });

/** What a check result does to a monitor: its new status, and whether an incident opens or resolves. */
export function transition(previous: MonitorStatus, ok: boolean): { status: MonitorStatus; opens: boolean; resolves: boolean } {
  if (ok) return { status: "up", opens: false, resolves: previous === "down" };
  return { status: "down", opens: previous !== "down", resolves: false };
}

export interface AlertPayload {
  event: "monitor.down" | "monitor.up";
  monitor: { id: string; name: string; url: string };
  incidentId: string;
  cause: string;
  at: string;
}

/** The exact body that is stored, signed and sent. Key order is fixed. */
export const alertBody = (p: AlertPayload): string =>
  JSON.stringify({ event: p.event, monitor: { id: p.monitor.id, name: p.monitor.name, url: p.monitor.url },
    incidentId: p.incidentId, cause: p.cause, at: p.at });
