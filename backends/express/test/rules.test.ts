import { describe, expect, it } from "vitest";
import {
  alertBody, backoffSeconds, connectionOutcome, newApiKey, orgSlug, responseOutcome, sha256Hex, signature, slugify,
  timeoutOutcome, transition,
} from "../src/domain/rules";

// The same values are pinned in the Spring and .NET unit tests.

describe("slugs", () => {
  it("slugifies names", () => {
    expect(slugify("  Acme Corp!! ")).toBe("acme-corp");
    expect(slugify("Ünïcode ☃ Labs")).toBe("n-code-labs");
    expect(slugify("!!!")).toBe("org");
    expect(slugify("a".repeat(39) + " b")).toBe("a".repeat(39));
  });

  it("adds a 4 character random suffix", () => {
    expect(orgSlug("Acme Corp")).toMatch(/^acme-corp-[a-z0-9]{4}$/);
  });
});

describe("api keys", () => {
  it("are pw_ plus 48 hex chars, stored as SHA-256", () => {
    const { key, prefix, hash } = newApiKey();
    expect(key).toMatch(/^pw_[0-9a-f]{48}$/);
    expect(prefix).toBe(key.slice(0, 10));
    expect(hash).toBe(sha256Hex(key));
    expect(sha256Hex("pw_test")).toBe("7385aabf0686675cf3f41051fc92d688d2c06abb5915f83dcb12b1ca2abfece7");
  });
});

describe("webhooks", () => {
  it("signs the raw body with HMAC-SHA256", () => {
    expect(signature("topsecret", '{"event":"monitor.down"}'))
      .toBe("sha256=c4ca1ce2fb7ca855eac003c9d72f6eb2314d5a15e497849c61c8f04b203a7557");
  });

  it("serialises the payload with a fixed key order", () => {
    expect(alertBody({
      event: "monitor.up", monitor: { id: "m1", name: "API", url: "https://x" }, incidentId: "i1", cause: "c",
      at: "2026-01-01T00:00:00.000Z",
    })).toBe('{"event":"monitor.up","monitor":{"id":"m1","name":"API","url":"https://x"},"incidentId":"i1","cause":"c","at":"2026-01-01T00:00:00.000Z"}');
  });

  it("backs off exponentially", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([2, 4, 8, 16]);
  });
});

describe("check outcomes", () => {
  it("compares the status with the expected one", () => {
    expect(responseOutcome(200, 200, 12)).toEqual({ ok: true, statusCode: 200, latencyMs: 12, error: null });
    expect(responseOutcome(503, 200, 12).error).toBe("expected 200 but got 503");
    expect(timeoutOutcome(1000, 1001).error).toBe("timeout after 1000 ms");
    expect(connectionOutcome("ECONNREFUSED", 3).error).toBe("connection failed: ECONNREFUSED");
  });

  it("opens an incident on the first failure and resolves it on recovery", () => {
    expect(transition("pending", false)).toEqual({ status: "down", opens: true, resolves: false });
    expect(transition("up", false)).toEqual({ status: "down", opens: true, resolves: false });
    expect(transition("down", false)).toEqual({ status: "down", opens: false, resolves: false });
    expect(transition("down", true)).toEqual({ status: "up", opens: false, resolves: true });
    expect(transition("pending", true)).toEqual({ status: "up", opens: false, resolves: false });
  });
});
