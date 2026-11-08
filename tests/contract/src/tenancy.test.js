import { describe, expect, it } from "vitest";
import { addMember, api, createMonitor, expectProblem, registerOrg, uniqueEmail } from "./client.js";

describe("tenant isolation", () => {
  it("hides another org's monitors entirely", async () => {
    const a = await registerOrg("tenant-a");
    const b = await registerOrg("tenant-b");
    const monitor = await createMonitor({ token: a.token });

    expect((await api("GET", "/monitors", { token: b.token })).body).toEqual([]);
    expectProblem(await api("GET", `/monitors/${monitor.id}`, { token: b.token }), 404, "NOT_FOUND");
    expectProblem(await api("PATCH", `/monitors/${monitor.id}`, { token: b.token, body: { name: "stolen" } }), 404, "NOT_FOUND");
    expectProblem(await api("DELETE", `/monitors/${monitor.id}`, { token: b.token }), 404, "NOT_FOUND");
    expectProblem(await api("GET", `/monitors/${monitor.id}/checks`, { token: b.token }), 404, "NOT_FOUND");
    expectProblem(await api("POST", `/monitors/${monitor.id}/check`, { token: b.token }), 404, "NOT_FOUND");

    const own = await api("GET", `/monitors/${monitor.id}`, { token: a.token });
    expect(own.status).toBe(200);
    expect(own.body.name).toBe(monitor.name);
  });

  it("answers 404 for ids that are not UUIDs", async () => {
    const a = await registerOrg("badid");
    expectProblem(await api("GET", "/monitors/not-a-uuid", { token: a.token }), 404, "NOT_FOUND");
  });
});

describe("roles", () => {
  it("lets the owner add admins and viewers", async () => {
    const owner = await registerOrg("roles");
    const email = uniqueEmail("viewer");
    const res = await api("POST", "/members", { token: owner.token, body: { email, password: "password123", role: "viewer" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, role: "viewer" });

    const members = await api("GET", "/members", { token: owner.token });
    expect(members.body.map((m) => m.role)).toEqual(["owner", "viewer"]);
    expectProblem(await api("POST", "/members", { token: owner.token, body: { email, password: "password123", role: "viewer" } }),
      409, "EMAIL_TAKEN");
    expectProblem(await api("POST", "/members", { token: owner.token, body: { email: uniqueEmail("x"), password: "password123", role: "owner" } }),
      400, "VALIDATION_ERROR");
  });

  it("keeps viewers read-only", async () => {
    const owner = await registerOrg("viewer");
    const monitor = await createMonitor({ token: owner.token });
    const viewer = await addMember(owner.token, "viewer");
    expect(viewer.user).toMatchObject({ role: "viewer", orgId: owner.user.orgId });

    expect((await api("GET", "/monitors", { token: viewer.token })).body.map((m) => m.id)).toEqual([monitor.id]);
    expectProblem(await api("POST", "/monitors", { token: viewer.token, body: { name: "x", url: "http://x.test/" } }), 403, "FORBIDDEN");
    expectProblem(await api("DELETE", `/monitors/${monitor.id}`, { token: viewer.token }), 403, "FORBIDDEN");
    expectProblem(await api("GET", "/api-keys", { token: viewer.token }), 403, "FORBIDDEN");
    const org = await api("GET", "/org", { token: viewer.token });
    expect(org.status).toBe(200);
    expect(org.body.webhookSecret).toBeUndefined();
  });

  it("lets admins manage monitors but not members", async () => {
    const owner = await registerOrg("admin");
    const admin = await addMember(owner.token, "admin");
    const monitor = await createMonitor({ token: admin.token });
    expect(monitor.id).toEqual(expect.any(String));
    expectProblem(await api("POST", "/members", { token: admin.token, body: { email: uniqueEmail("x"), password: "password123", role: "viewer" } }),
      403, "FORBIDDEN");
  });
});
