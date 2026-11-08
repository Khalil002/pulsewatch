import { describe, expect, it } from "vitest";
import { api, checksOf, createMonitor, eventually, expectProblem, registerOrg, target, TARGET_URL } from "./client.js";

const monitorStatus = (token, id, status) => eventually(async () => {
  const res = await api("GET", `/monitors/${id}`, { token });
  return res.body.status === status ? res.body : undefined;
});

describe("checks", () => {
  it("run as soon as a monitor is created", async () => {
    const owner = await registerOrg("checks");
    const t = await target(200);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url });
    const [check] = await checksOf(owner.token, monitor.id);
    expect(check).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    const up = await monitorStatus(owner.token, monitor.id, "up");
    expect(up.lastCheckedAt).toEqual(expect.any(String));
  });

  it("fail when the status is not the expected one", async () => {
    const owner = await registerOrg("unexpected");
    const t = await target(503);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url });
    const [check] = await checksOf(owner.token, monitor.id);
    expect(check).toMatchObject({ ok: false, statusCode: 503, error: "expected 200 but got 503" });
    await monitorStatus(owner.token, monitor.id, "down");
  });

  it("honour expectedStatus and HEAD", async () => {
    const owner = await registerOrg("expected");
    const t = await target(204);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url, method: "HEAD", expectedStatus: 204 });
    const [check] = await checksOf(owner.token, monitor.id);
    expect(check).toMatchObject({ ok: true, statusCode: 204 });
  });

  it("time out", async () => {
    const owner = await registerOrg("timeout");
    const monitor = await createMonitor({ token: owner.token }, { url: `${TARGET_URL}/slow/3000`, timeoutMs: 500 });
    const [check] = await checksOf(owner.token, monitor.id);
    expect(check).toMatchObject({ ok: false, statusCode: null, error: "timeout after 500 ms" });
  });

  it("report connection failures", async () => {
    const owner = await registerOrg("refused");
    const monitor = await createMonitor({ token: owner.token }, { url: "http://testbed:1/" });
    const [check] = await checksOf(owner.token, monitor.id);
    expect(check.ok).toBe(false);
    expect(check.statusCode).toBeNull();
    expect(check.error).toMatch(/^connection failed: /);
  });

  it("can be triggered on demand", async () => {
    const owner = await registerOrg("trigger");
    const t = await target(200);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url, intervalSec: 3600 });
    await checksOf(owner.token, monitor.id, 1);
    const res = await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    const checks = await checksOf(owner.token, monitor.id, 2);
    expect(checks).toHaveLength(2);
  });

  it("are skipped while paused", async () => {
    const owner = await registerOrg("paused");
    const t = await target(200);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url, paused: true });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await api("GET", `/monitors/${monitor.id}/checks`, { token: owner.token })).body).toEqual([]);
  });

  it("validate the limit", async () => {
    const owner = await registerOrg("limit");
    const monitor = await createMonitor({ token: owner.token });
    expectProblem(await api("GET", `/monitors/${monitor.id}/checks?limit=0`, { token: owner.token }), 400, "VALIDATION_ERROR");
  });
});

describe("incidents", () => {
  it("open when a monitor goes down and resolve when it recovers", async () => {
    const owner = await registerOrg("incident");
    const t = await target(200);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url });
    await monitorStatus(owner.token, monitor.id, "up");

    await t.set(500);
    await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
    await monitorStatus(owner.token, monitor.id, "down");
    const open = await api("GET", "/incidents?status=open", { token: owner.token });
    expect(open.body).toHaveLength(1);
    expect(open.body[0]).toMatchObject({ monitorId: monitor.id, monitorName: monitor.name, resolvedAt: null,
      cause: "expected 200 but got 500" });

    // More failures don't open more incidents.
    await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
    await checksOf(owner.token, monitor.id, 3);
    expect((await api("GET", "/incidents", { token: owner.token })).body).toHaveLength(1);

    await t.set(200);
    await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
    await monitorStatus(owner.token, monitor.id, "up");
    expect((await api("GET", "/incidents?status=open", { token: owner.token })).body).toEqual([]);
    const resolved = await api("GET", `/incidents?status=resolved&monitorId=${monitor.id}`, { token: owner.token });
    expect(resolved.body).toHaveLength(1);
    expect(resolved.body[0].id).toBe(open.body[0].id);
    expect(new Date(resolved.body[0].resolvedAt) >= new Date(resolved.body[0].startedAt)).toBe(true);
    expectProblem(await api("GET", "/incidents?status=maybe", { token: owner.token }), 400, "VALIDATION_ERROR");
  });
});

describe("stats", () => {
  it("summarise the last 24 hours", async () => {
    const owner = await registerOrg("stats");
    const t = await target(200);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url });
    await checksOf(owner.token, monitor.id, 1);
    await t.set(500);
    await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
    await checksOf(owner.token, monitor.id, 2);
    await t.set(200);
    for (const n of [3, 4]) {
      await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
      await checksOf(owner.token, monitor.id, n);
    }

    const res = await api("GET", `/monitors/${monitor.id}/stats`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checks: 4, failures: 1, uptimePercent: 75 });
    expect(res.body.avgLatencyMs).toEqual(expect.any(Number));
    expect(res.body.p95LatencyMs).toBeGreaterThanOrEqual(0);
    const checks = res.body.hourly.reduce((sum, h) => sum + h.checks, 0);
    expect(checks).toBe(4);
    expect(res.body.hourly[0].hour).toMatch(/:00:00/);
  });

  it("are empty before the first check", async () => {
    const owner = await registerOrg("nostats");
    const monitor = await createMonitor({ token: owner.token }, { paused: true });
    const res = await api("GET", `/monitors/${monitor.id}/stats`, { token: owner.token });
    expect(res.body).toEqual({ checks: 0, failures: 0, uptimePercent: null, avgLatencyMs: null, p95LatencyMs: null, hourly: [] });
  });
});
