import { config } from "./config";
import { withSystem } from "./db";
import { alertsTotal, checkDuration, checksTotal } from "./metrics";
import {
  alertBody, backoffSeconds, connectionOutcome, MAX_ALERT_ATTEMPTS, responseOutcome, signature, timeoutOutcome,
  transition, type CheckOutcome, type MonitorStatus,
} from "./domain/rules";

// Background work that runs in every replica. Rows are claimed with FOR UPDATE SKIP LOCKED,
// so replicas never run the same check or deliver the same alert twice.

const USER_AGENT = "pulsewatch/1.0 (express)";
const DELIVERY_TIMEOUT_MS = 5000;
/** A claimed delivery is invisible to other workers for this long, in case this one dies mid-request. */
const DELIVERY_LEASE_SEC = 60;
const ALERT_BATCH = 10;

interface DueMonitor {
  id: string; url: string; method: string; timeout_ms: number; expected_status: number;
}

export async function runCheck(m: DueMonitor): Promise<CheckOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(m.url, {
      method: m.method, redirect: "manual", headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(m.timeout_ms),
    });
    const latency = elapsed();
    await res.body?.cancel().catch(() => undefined);
    return responseOutcome(res.status, m.expected_status, latency);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") return timeoutOutcome(m.timeout_ms, elapsed());
    return connectionOutcome(e.cause?.code ?? e.cause?.message ?? e.message, elapsed());
  }
}

/** Stores a result and applies its consequences (status, incident, alert) in one transaction. */
export async function recordCheck(monitorId: string, outcome: CheckOutcome): Promise<void> {
  await withSystem(async (db) => {
    const m = (await db.query<{ org_id: string; name: string; url: string; status: MonitorStatus; alert_webhook_url: string | null }>(
      "SELECT org_id, name, url, status, alert_webhook_url FROM monitors WHERE id = $1 FOR UPDATE", [monitorId])).rows[0];
    if (!m) return; // deleted while the check ran
    await db.query(
      `INSERT INTO check_results (monitor_id, org_id, ok, status_code, latency_ms, error) VALUES ($1, $2, $3, $4, $5, $6)`,
      [monitorId, m.org_id, outcome.ok, outcome.statusCode, outcome.latencyMs, outcome.error]);
    const next = transition(m.status, outcome.ok);
    await db.query("UPDATE monitors SET status = $2, last_checked_at = now() WHERE id = $1", [monitorId, next.status]);

    let incident: { id: string; cause: string } | undefined;
    let event: "monitor.down" | "monitor.up" | undefined;
    if (next.opens) {
      incident = (await db.query<{ id: string; cause: string }>(
        `INSERT INTO incidents (monitor_id, org_id, cause) VALUES ($1, $2, $3)
         ON CONFLICT (monitor_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id, cause`,
        [monitorId, m.org_id, outcome.error])).rows[0];
      event = "monitor.down";
    } else if (next.resolves) {
      incident = (await db.query<{ id: string; cause: string }>(
        "UPDATE incidents SET resolved_at = now() WHERE monitor_id = $1 AND resolved_at IS NULL RETURNING id, cause",
        [monitorId])).rows[0];
      event = "monitor.up";
    }
    if (incident && event && m.alert_webhook_url) {
      const payload = alertBody({
        event, monitor: { id: monitorId, name: m.name, url: m.url }, incidentId: incident.id, cause: incident.cause,
        at: new Date().toISOString(),
      });
      await db.query(
        `INSERT INTO alert_jobs (org_id, monitor_id, incident_id, event, target_url, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
        [m.org_id, monitorId, incident.id, event, m.alert_webhook_url, payload]);
    }
  });
  checksTotal.inc({ result: outcome.ok ? "success" : "failure" });
  checkDuration.observe(outcome.latencyMs / 1000);
}

let inFlight = 0;

/** Claims due monitors (pushing their next_check_at forward) and runs their checks in the background. */
export async function schedulerTick(): Promise<number> {
  const room = config.maxInFlightChecks - inFlight;
  if (room <= 0) return 0;
  const due = await withSystem(async (db) => (await db.query<DueMonitor>(
    `UPDATE monitors m SET next_check_at = now() + make_interval(secs => m.interval_sec)
      WHERE m.id IN (SELECT id FROM monitors WHERE NOT paused AND next_check_at <= now()
                      ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING m.id, m.url, m.method, m.timeout_ms, m.expected_status`, [room])).rows);
  for (const m of due) {
    inFlight++;
    runCheck(m)
      .then((outcome) => recordCheck(m.id, outcome))
      .catch((err) => console.error("[scheduler]", m.id, (err as Error).message))
      .finally(() => { inFlight--; });
  }
  return due.length;
}

interface ClaimedAlert { id: string; target_url: string; payload: string; event: string; attempts: number; secret: string }

export async function deliver(job: ClaimedAlert): Promise<string | null> {
  try {
    const res = await fetch(job.target_url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-pulsewatch-event": job.event,
        "x-pulsewatch-signature": signature(job.secret, job.payload),
      },
      body: job.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? null : `webhook responded ${res.status}`;
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError") return `timeout after ${DELIVERY_TIMEOUT_MS} ms`;
    return `connection failed: ${e.cause?.code ?? e.cause?.message ?? e.message}`;
  }
}

/** Delivers due alert jobs: claim with a lease, send, then mark sent, retry later, or give up. */
export async function alertTick(): Promise<number> {
  const jobs = await withSystem(async (db) => (await db.query<ClaimedAlert>(
    `UPDATE alert_jobs j SET attempts = j.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
       FROM orgs o
      WHERE o.id = j.org_id
        AND j.id IN (SELECT id FROM alert_jobs WHERE status = 'pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING j.id, j.target_url, j.payload, j.event, j.attempts, o.webhook_secret AS secret`,
    [ALERT_BATCH, DELIVERY_LEASE_SEC])).rows);
  await Promise.all(jobs.map(async (job) => {
    const error = await deliver(job);
    const outcome = error === null ? "sent" : job.attempts >= MAX_ALERT_ATTEMPTS ? "dead" : "retry";
    await withSystem((db) => db.query(
      `UPDATE alert_jobs SET status = $2, last_error = $3,
              sent_at = CASE WHEN $2 = 'sent' THEN now() END,
              next_attempt_at = now() + make_interval(secs => $4)
        WHERE id = $1`,
      [job.id, outcome === "retry" ? "pending" : outcome, error, backoffSeconds(job.attempts)]));
    alertsTotal.inc({ outcome });
  }));
  return jobs.length;
}

export async function retentionSweep(): Promise<number> {
  return withSystem(async (db) => (await db.query(
    "DELETE FROM check_results WHERE checked_at < now() - make_interval(days => $1)", [config.retentionDays])).rowCount ?? 0);
}

/** Runs the scheduler and alert worker every tick, and retention hourly, until stop() is called. */
export function startWorkers(): () => void {
  let stopped = false;
  const loop = async (name: string, everyMs: number, tick: () => Promise<unknown>) => {
    while (!stopped) {
      try { await tick(); } catch (err) { console.error(`[${name}]`, (err as Error).message); }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  };
  void loop("scheduler", config.schedulerTickMs, schedulerTick);
  void loop("alerts", config.schedulerTickMs, alertTick);
  void loop("retention", 3_600_000, retentionSweep);
  return () => { stopped = true; };
}
