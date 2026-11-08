import { randomUUID } from "node:crypto";

export const API_URL = (process.env.API_URL ?? "http://localhost:8080/api").replace(/\/$/, "");
/** The testbed as the tests reach it, and as the backend (inside the compose network) reaches it. */
export const TESTBED_URL = (process.env.TESTBED_URL ?? "http://localhost:9000").replace(/\/$/, "");
export const TARGET_URL = (process.env.TARGET_URL ?? "http://testbed:9000").replace(/\/$/, "");
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);

export async function api(method, path, { token, apiKey, body, headers = {} } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

export async function testbed(method, path, body) {
  const res = await fetch(`${TESTBED_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

export const uid = () => randomUUID().slice(0, 12);
export const uniqueEmail = (tag = "user") => `${tag}-${uid()}@test.local`;

/** A fresh org with its owner. */
export async function registerOrg(tag = "org") {
  const res = await api("POST", "/auth/register", {
    body: { email: uniqueEmail(tag), password: "password123", orgName: `${tag} ${uid()}` },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Adds a member to the owner's org and signs them in. */
export async function addMember(ownerToken, role) {
  const email = uniqueEmail(role);
  const created = await api("POST", "/members", { token: ownerToken, body: { email, password: "password123", role } });
  if (created.status !== 201) throw new Error(`add member failed: ${created.status} ${JSON.stringify(created.body)}`);
  const login = await api("POST", "/auth/login", { body: { email, password: "password123" } });
  return login.body;
}

/** A testbed target key the backend can check, set to respond with `status` after `delayMs`. */
export async function target(status = 200, delayMs = 0) {
  const key = uid();
  await testbed("PUT", `/targets/${key}`, { status, delayMs });
  return { key, url: `${TARGET_URL}/t/${key}`, set: (s, d = 0) => testbed("PUT", `/targets/${key}`, { status: s, delayMs: d }) };
}

/** A testbed webhook receiver. */
export function hook() {
  const key = uid();
  return {
    key,
    url: `${TARGET_URL}/hooks/${key}`,
    failNext: (failTimes) => testbed("PUT", `/hooks/${key}`, { failTimes }),
    received: () => testbed("GET", `/hooks/${key}`),
  };
}

export async function createMonitor(auth, overrides = {}) {
  const res = await api("POST", "/monitors", { ...auth, body: { name: `Monitor ${uid()}`, url: "http://example.invalid/", ...overrides } });
  if (res.status !== 201) throw new Error(`create monitor failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function eventually(fn, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Waits until the monitor has at least `n` check results, then returns them (newest first). */
export async function checksOf(token, monitorId, n = 1) {
  return eventually(async () => {
    const res = await api("GET", `/monitors/${monitorId}/checks`, { token });
    return res.body.length >= n ? res.body : undefined;
  });
}

export const expectProblem = (res, status, code) => {
  if (res.status !== status || res.body?.code !== code) {
    throw new Error(`expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (!String(res.headers.get("content-type")).includes("application/problem+json")) {
    throw new Error(`expected problem+json, got ${res.headers.get("content-type")}`);
  }
};
