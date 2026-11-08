import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, createMonitor, eventually, expectProblem, hook, registerOrg, target } from "./client.js";

const alertsOf = (token, monitorId, predicate) => eventually(async () => {
  const res = await api("GET", `/alerts?monitorId=${monitorId}`, { token });
  return predicate(res.body) ? res.body : undefined;
}, { timeoutMs: 30_000 });

describe("alert webhooks", () => {
  it("are signed and sent when a monitor goes down and comes back", async () => {
    const owner = await registerOrg("webhook");
    const secret = (await api("GET", "/org", { token: owner.token })).body.webhookSecret;
    const t = await target(500);
    const h = hook();
    const monitor = await createMonitor({ token: owner.token }, { url: t.url, alertWebhookUrl: h.url });

    const [down] = await eventually(async () => {
      const received = await h.received();
      return received.length >= 1 ? received : undefined;
    });
    expect(down.headers["x-pulsewatch-event"]).toBe("monitor.down");
    expect(down.headers["content-type"]).toMatch(/application\/json/);
    const expected = `sha256=${createHmac("sha256", secret).update(down.body).digest("hex")}`;
    expect(down.headers["x-pulsewatch-signature"]).toBe(expected);
    const payload = JSON.parse(down.body);
    expect(payload).toMatchObject({
      event: "monitor.down",
      monitor: { id: monitor.id, name: monitor.name, url: t.url },
      incidentId: expect.any(String),
      cause: "expected 200 but got 500",
    });
    expect(new Date(payload.at).getTime()).not.toBeNaN();

    await t.set(200);
    await api("POST", `/monitors/${monitor.id}/check`, { token: owner.token });
    const received = await eventually(async () => {
      const all = await h.received();
      return all.length >= 2 ? all : undefined;
    });
    const up = JSON.parse(received[1].body);
    expect(up).toMatchObject({ event: "monitor.up", incidentId: payload.incidentId, cause: payload.cause });

    const alerts = await alertsOf(owner.token, monitor.id, (a) => a.length === 2 && a.every((x) => x.status === "sent"));
    expect(alerts.map((a) => a.event).sort()).toEqual(["monitor.down", "monitor.up"]);
    expect(alerts[0]).toMatchObject({ monitorId: monitor.id, attempts: 1, lastError: null, sentAt: expect.any(String) });
  });

  it("are retried with backoff when the receiver fails", async () => {
    const owner = await registerOrg("retry");
    const t = await target(500);
    const h = hook();
    await h.failNext(1);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url, alertWebhookUrl: h.url });

    const failed = await alertsOf(owner.token, monitor.id, (a) => a[0]?.attempts === 1 && a[0].status === "pending" && a[0].lastError !== null);
    expect(failed[0].lastError).toBe("webhook responded 500");
    const [sent] = await alertsOf(owner.token, monitor.id, (a) => a[0]?.status === "sent");
    expect(sent).toMatchObject({ attempts: 2, lastError: null });
    expect(await h.received()).toHaveLength(1);
  });

  it("are not queued without a webhook URL", async () => {
    const owner = await registerOrg("nohook");
    const t = await target(500);
    const monitor = await createMonitor({ token: owner.token }, { url: t.url });
    await eventually(async () => (await api("GET", "/incidents?status=open", { token: owner.token })).body.length === 1);
    expect((await api("GET", "/alerts", { token: owner.token })).body).toEqual([]);
    expectProblem(await api("GET", "/alerts?monitorId=nope", { token: owner.token }), 400, "VALIDATION_ERROR");
    expect(monitor.alertWebhookUrl).toBeNull();
  });
});

describe("status page", () => {
  it("is public, hides URLs and paused monitors, and is cached", async () => {
    const owner = await registerOrg("status");
    const slug = (await api("GET", "/org", { token: owner.token })).body.slug;
    const healthy = await target(200);
    const broken = await target(503);
    const a = await createMonitor({ token: owner.token }, { name: "API", url: healthy.url });
    const b = await createMonitor({ token: owner.token }, { name: "Billing", url: broken.url });
    await createMonitor({ token: owner.token }, { name: "Old thing", paused: true });
    await eventually(async () => {
      const list = (await api("GET", "/monitors", { token: owner.token })).body;
      return list.find((m) => m.id === a.id).status === "up" && list.find((m) => m.id === b.id).status === "down";
    });

    const first = await api("GET", `/status/${slug}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(first.body).toMatchObject({ slug, overall: "degraded" });
    expect(first.body.name).toMatch(/^status /);
    expect(first.body.monitors).toEqual([
      { name: "API", status: "up", uptimePercent: 100, lastCheckedAt: expect.any(String) },
      { name: "Billing", status: "down", uptimePercent: 0, lastCheckedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(first.body)).not.toContain(healthy.url);

    const second = await api("GET", `/status/${slug}`);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(second.body).toEqual(first.body);
  });

  it("is operational when nothing is down", async () => {
    const owner = await registerOrg("calm");
    const slug = (await api("GET", "/org", { token: owner.token })).body.slug;
    const res = await api("GET", `/status/${slug}`);
    expect(res.body).toMatchObject({ overall: "operational", monitors: [] });
  });

  it("answers 404 for unknown slugs", async () => {
    expectProblem(await api("GET", "/status/no-such-org-zzzz"), 404, "NOT_FOUND");
  });
});
