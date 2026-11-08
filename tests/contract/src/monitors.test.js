import { describe, expect, it } from "vitest";
import { api, createMonitor, expectProblem, registerOrg } from "./client.js";

describe("monitors", () => {
  it("are created with defaults", async () => {
    const owner = await registerOrg("defaults");
    const res = await api("POST", "/monitors", { token: owner.token, body: { name: "Homepage", url: "https://example.com/" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Homepage", url: "https://example.com/", method: "GET", intervalSec: 60, timeoutMs: 5000,
      expectedStatus: 200, alertWebhookUrl: null, paused: false, status: "pending", lastCheckedAt: null,
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(new Date(res.body.createdAt).getTime()).not.toBeNaN();
  });

  it("validate their fields", async () => {
    const owner = await registerOrg("validate");
    for (const body of [
      { name: "x", url: "ftp://example.com" },
      { name: "x", url: "https://example.com", intervalSec: 5 },
      { name: "x", url: "https://example.com", timeoutMs: 20000 },
      { name: "x", url: "https://example.com", method: "POST" },
      { name: "x", url: "https://example.com", expectedStatus: 700 },
      { name: "", url: "https://example.com" },
      { name: "x", url: "https://example.com", alertWebhookUrl: "not a url" },
    ]) {
      expectProblem(await api("POST", "/monitors", { token: owner.token, body }), 400, "VALIDATION_ERROR");
    }
  });

  it("are listed newest first", async () => {
    const owner = await registerOrg("list");
    const first = await createMonitor({ token: owner.token });
    const second = await createMonitor({ token: owner.token });
    const res = await api("GET", "/monitors", { token: owner.token });
    expect(res.body.map((m) => m.id)).toEqual([second.id, first.id]);
  });

  it("can be patched", async () => {
    const owner = await registerOrg("patch");
    const monitor = await createMonitor({ token: owner.token });
    const res = await api("PATCH", `/monitors/${monitor.id}`, {
      token: owner.token, body: { name: "Renamed", intervalSec: 300, method: "HEAD", paused: true, alertWebhookUrl: "https://hooks.test/x" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: monitor.id, name: "Renamed", intervalSec: 300, method: "HEAD", paused: true,
      alertWebhookUrl: "https://hooks.test/x", url: monitor.url });
    const cleared = await api("PATCH", `/monitors/${monitor.id}`, { token: owner.token, body: { alertWebhookUrl: null } });
    expect(cleared.body.alertWebhookUrl).toBeNull();
    expectProblem(await api("PATCH", `/monitors/${monitor.id}`, { token: owner.token, body: {} }), 400, "VALIDATION_ERROR");
    expectProblem(await api("PATCH", `/monitors/${monitor.id}`, { token: owner.token, body: { intervalSec: 1 } }), 400, "VALIDATION_ERROR");
  });

  it("can be deleted", async () => {
    const owner = await registerOrg("delete");
    const monitor = await createMonitor({ token: owner.token });
    expect((await api("DELETE", `/monitors/${monitor.id}`, { token: owner.token })).status).toBe(204);
    expectProblem(await api("GET", `/monitors/${monitor.id}`, { token: owner.token }), 404, "NOT_FOUND");
    expectProblem(await api("DELETE", `/monitors/${monitor.id}`, { token: owner.token }), 404, "NOT_FOUND");
  });
});
