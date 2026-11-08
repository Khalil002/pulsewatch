// Fake HTTP targets and webhook receivers for demos and the contract tests. No dependencies.
//
//   GET|HEAD /t/:key            responds as configured for :key (default 200, no delay)
//   PUT      /targets/:key      {"status": 503, "delayMs": 0}
//   GET      /status/:code      always responds with :code
//   GET      /slow/:ms          responds 200 after :ms milliseconds
//   PUT      /hooks/:key        {"failTimes": 2} makes the next N deliveries return 500
//   POST     /hooks/:key        records the delivery (headers + raw body)
//   GET      /hooks/:key        lists recorded deliveries, oldest first
import { createServer } from "node:http";

const targets = new Map();
const hooks = new Map();
const hook = (key) => hooks.get(key) ?? hooks.set(key, { failTimes: 0, received: [] }).get(key);

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const [, kind, key] = new URL(req.url, "http://x").pathname.split("/");
  const body = await readBody(req);
  try {
    if (kind === "t" && (req.method === "GET" || req.method === "HEAD")) {
      const t = targets.get(key) ?? { status: 200, delayMs: 0 };
      await sleep(t.delayMs);
      return json(res, t.status, req.method === "HEAD" ? undefined : { key, status: t.status });
    }
    if (kind === "targets" && req.method === "PUT") {
      const { status = 200, delayMs = 0 } = JSON.parse(body || "{}");
      targets.set(key, { status, delayMs });
      return json(res, 200, targets.get(key));
    }
    if (kind === "status") return json(res, Number(key) || 200, { status: Number(key) });
    if (kind === "slow") { await sleep(Number(key) || 0); return json(res, 200, { slept: Number(key) }); }
    if (kind === "hooks" && req.method === "PUT") {
      hook(key).failTimes = JSON.parse(body || "{}").failTimes ?? 0;
      return json(res, 200, { failTimes: hook(key).failTimes });
    }
    if (kind === "hooks" && req.method === "POST") {
      const h = hook(key);
      if (h.failTimes > 0) { h.failTimes -= 1; return json(res, 500, { error: "configured to fail" }); }
      h.received.push({ headers: req.headers, body, at: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }
    if (kind === "hooks" && req.method === "GET") return json(res, 200, hook(key).received);
    if (kind === "health") return json(res, 200, { status: "ok" });
    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 400, { error: String(err) });
  }
}).listen(9000, () => console.log("testbed listening on :9000"));
