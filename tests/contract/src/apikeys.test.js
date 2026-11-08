import { describe, expect, it } from "vitest";
import { api, createMonitor, expectProblem, RATE_LIMIT_MAX, registerOrg } from "./client.js";

async function newKey(token, name = "ci") {
  const res = await api("POST", "/api-keys", { token, body: { name } });
  if (res.status !== 201) throw new Error(`create key failed: ${res.status}`);
  return res.body;
}

describe("API keys", () => {
  it("are shown once and listed without the secret", async () => {
    const owner = await registerOrg("keys");
    const created = await newKey(owner.token, "deploy bot");
    expect(created.key).toMatch(/^pw_[0-9a-f]{48}$/);
    expect(created).toMatchObject({ name: "deploy bot", prefix: created.key.slice(0, 10), revokedAt: null, lastUsedAt: null });

    const list = await api("GET", "/api-keys", { token: owner.token });
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(created.id);
    expect(list.body[0].key).toBeUndefined();
  });

  it("authenticate as an admin of the org", async () => {
    const owner = await registerOrg("keyuse");
    const { key } = await newKey(owner.token);
    const monitor = await createMonitor({ apiKey: key });
    const list = await api("GET", "/monitors", { token: owner.token });
    expect(list.body.map((m) => m.id)).toEqual([monitor.id]);

    const keys = await api("GET", "/api-keys", { token: owner.token });
    expect(keys.body[0].lastUsedAt).toEqual(expect.any(String));
  });

  it("cannot manage keys or act as a user", async () => {
    const owner = await registerOrg("keylimits");
    const { key } = await newKey(owner.token);
    expectProblem(await api("GET", "/api-keys", { apiKey: key }), 403, "FORBIDDEN");
    expectProblem(await api("POST", "/api-keys", { apiKey: key, body: { name: "more" } }), 403, "FORBIDDEN");
    expectProblem(await api("GET", "/me", { apiKey: key }), 403, "FORBIDDEN");
    expectProblem(await api("POST", "/members", { apiKey: key, body: { email: "a@b.test", password: "password123", role: "viewer" } }),
      403, "FORBIDDEN");
  });

  it("stop working once revoked", async () => {
    const owner = await registerOrg("revoke");
    const created = await newKey(owner.token);
    expect((await api("GET", "/monitors", { apiKey: created.key })).status).toBe(200);
    expect((await api("DELETE", `/api-keys/${created.id}`, { token: owner.token })).status).toBe(204);
    expectProblem(await api("GET", "/monitors", { apiKey: created.key }), 401, "UNAUTHORIZED");
    const list = await api("GET", "/api-keys", { token: owner.token });
    expect(list.body[0].revokedAt).toEqual(expect.any(String));
    expectProblem(await api("GET", "/monitors", { apiKey: "pw_not-a-real-key" }), 401, "UNAUTHORIZED");
  });

  it("are rate limited per key", async () => {
    const owner = await registerOrg("ratelimit");
    const { key } = await newKey(owner.token);
    const other = await newKey(owner.token, "other");
    let limited;
    for (let i = 0; i < RATE_LIMIT_MAX + 5 && !limited; i++) {
      const res = await api("GET", "/monitors", { apiKey: key });
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    expectProblem(limited, 429, "RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another key of the same org has its own budget.
    expect((await api("GET", "/monitors", { apiKey: other.key })).status).toBe(200);
  });
});
