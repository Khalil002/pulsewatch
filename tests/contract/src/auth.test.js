import { describe, expect, it } from "vitest";
import { api, expectProblem, registerOrg, uniqueEmail } from "./client.js";

describe("health", () => {
  it("reports which backend is serving", async () => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(["spring", "express", "dotnet"]).toContain(res.body.backend);
  });
});

describe("registration and login", () => {
  it("creates an org with its owner", async () => {
    const email = uniqueEmail("owner");
    const res = await api("POST", "/auth/register", { body: { email, password: "password123", orgName: "Acme Corp!" } });
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email, role: "owner", orgId: expect.any(String) });

    const org = await api("GET", "/org", { token: res.body.token });
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ id: res.body.user.orgId, name: "Acme Corp!" });
    expect(org.body.slug).toMatch(/^acme-corp-[a-z0-9]{4}$/);
    expect(org.body.webhookSecret).toEqual(expect.any(String));
  });

  it("rejects a duplicate email regardless of case", async () => {
    const email = uniqueEmail("dup");
    await api("POST", "/auth/register", { body: { email, password: "password123", orgName: "First" } });
    const res = await api("POST", "/auth/register", { body: { email: email.toUpperCase(), password: "password123", orgName: "Second" } });
    expectProblem(res, 409, "EMAIL_TAKEN");
  });

  it("validates the body", async () => {
    const res = await api("POST", "/auth/register", { body: { email: "nope", password: "short", orgName: "x" } });
    expectProblem(res, 400, "VALIDATION_ERROR");
  });

  it("logs in and returns the user", async () => {
    const owner = await registerOrg("login");
    const res = await api("POST", "/auth/login", { body: { email: owner.user.email, password: "password123" } });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(owner.user);
    const me = await api("GET", "/me", { token: res.body.token });
    expect(me.body).toEqual(owner.user);
  });

  it("rejects bad credentials and missing tokens", async () => {
    expectProblem(await api("POST", "/auth/login", { body: { email: "admin@pulsewatch.local", password: "wrong-password" } }),
      401, "INVALID_CREDENTIALS");
    expectProblem(await api("GET", "/monitors"), 401, "UNAUTHORIZED");
    expectProblem(await api("GET", "/monitors", { token: "not-a-jwt" }), 401, "UNAUTHORIZED");
  });

  it("ships a demo owner", async () => {
    const res = await api("POST", "/auth/login", { body: { email: "admin@pulsewatch.local", password: "admin1234" } });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("owner");
  });
});
