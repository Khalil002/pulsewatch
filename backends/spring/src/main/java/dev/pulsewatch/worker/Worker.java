package dev.pulsewatch.worker;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.pulsewatch.config.AppProperties;
import dev.pulsewatch.config.Tenancy;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Background work that runs in every replica. Rows are claimed with FOR UPDATE SKIP LOCKED, so
 * replicas never run the same check or deliver the same alert twice. Checks run on virtual threads.
 */
@Component
public class Worker {
    private static final Logger log = LoggerFactory.getLogger(Worker.class);
    private static final String USER_AGENT = "pulsewatch/1.0 (spring)";
    private static final int DELIVERY_TIMEOUT_MS = 5000;
    /** A claimed delivery is invisible to other workers for this long, in case this one dies mid-request. */
    private static final int DELIVERY_LEASE_SEC = 60;
    private static final int ALERT_BATCH = 10;

    record DueMonitor(UUID id, String url, String method, int timeoutMs, int expectedStatus) {}

    record Locked(UUID orgId, String name, String url, String status, String alertWebhookUrl) {}

    record IncidentRow(UUID id, String cause) {}

    record ClaimedAlert(UUID id, String targetUrl, String payload, String event, int attempts, String secret) {}

    private final JdbcClient db;
    private final Tenancy tenancy;
    private final AppProperties props;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ExecutorService checks = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicInteger inFlight = new AtomicInteger();
    private final Counter checkSuccess;
    private final Counter checkFailure;
    private final Timer checkDuration;
    private final MeterRegistry meters;

    public Worker(JdbcClient db, Tenancy tenancy, AppProperties props, ObjectMapper mapper, MeterRegistry meters) {
        this.db = db;
        this.tenancy = tenancy;
        this.props = props;
        this.mapper = mapper;
        this.meters = meters;
        // Same metric names in every backend: pulsewatch_checks_total, pulsewatch_check_duration_seconds, pulsewatch_alerts_total.
        this.checkSuccess = Counter.builder("pulsewatch.checks").description("Checks run, by result").tag("result", "success").register(meters);
        this.checkFailure = Counter.builder("pulsewatch.checks").description("Checks run, by result").tag("result", "failure").register(meters);
        this.checkDuration = Timer.builder("pulsewatch.check.duration").description("Time to the target's response headers").register(meters);
    }

    // --- checks ------------------------------------------------------------------

    public Rules.Outcome runCheck(DueMonitor m) {
        long started = System.nanoTime();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(m.url()))
                    .method(m.method(), HttpRequest.BodyPublishers.noBody())
                    .header("User-Agent", USER_AGENT)
                    .timeout(Duration.ofMillis(m.timeoutMs()))
                    .build();
            HttpResponse<InputStream> res = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            int latency = elapsed(started);
            res.body().close();
            return Rules.response(res.statusCode(), m.expectedStatus(), latency);
        } catch (HttpTimeoutException e) {
            return Rules.timeout(m.timeoutMs(), elapsed(started));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Rules.connectionFailed("interrupted", elapsed(started));
        } catch (Exception e) {
            return Rules.connectionFailed(reason(e), elapsed(started));
        }
    }

    private static int elapsed(long startedNanos) {
        return (int) TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
    }

    private static String reason(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String message = root.getMessage();
        if (e instanceof ConnectException && (message == null || message.isBlank())) return "connection refused";
        return message == null || message.isBlank() ? root.getClass().getSimpleName() : message;
    }

    /** Stores a result and applies its consequences (status, incident, alert) in one transaction. */
    public void recordCheck(UUID monitorId, Rules.Outcome outcome) {
        tenancy.asSystem(() -> {
            Optional<Locked> found = db.sql("SELECT org_id, name, url, status, alert_webhook_url FROM monitors WHERE id = ? FOR UPDATE")
                    .param(monitorId).query(Locked.class).optional();
            if (found.isEmpty()) return null; // deleted while the check ran
            Locked m = found.get();
            db.sql("INSERT INTO check_results (monitor_id, org_id, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)")
                    .params(monitorId, m.orgId(), outcome.ok(), outcome.statusCode(), outcome.latencyMs(), outcome.error()).update();
            Rules.Transition next = Rules.transition(m.status(), outcome.ok());
            db.sql("UPDATE monitors SET status = ?, last_checked_at = now() WHERE id = ?").params(next.status(), monitorId).update();

            Optional<IncidentRow> incident = Optional.empty();
            String event = null;
            if (next.opens()) {
                incident = db.sql("""
                                INSERT INTO incidents (monitor_id, org_id, cause) VALUES (?, ?, ?)
                                ON CONFLICT (monitor_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id, cause""")
                        .params(monitorId, m.orgId(), outcome.error()).query(IncidentRow.class).optional();
                event = "monitor.down";
            } else if (next.resolves()) {
                incident = db.sql("UPDATE incidents SET resolved_at = now() WHERE monitor_id = ? AND resolved_at IS NULL RETURNING id, cause")
                        .param(monitorId).query(IncidentRow.class).optional();
                event = "monitor.up";
            }
            if (incident.isPresent() && m.alertWebhookUrl() != null) {
                db.sql("INSERT INTO alert_jobs (org_id, monitor_id, incident_id, event, target_url, payload) VALUES (?, ?, ?, ?, ?, ?)")
                        .params(m.orgId(), monitorId, incident.get().id(), event, m.alertWebhookUrl(),
                                alertBody(event, monitorId, m.name(), m.url(), incident.get()))
                        .update();
            }
            return null;
        });
        (outcome.ok() ? checkSuccess : checkFailure).increment();
        checkDuration.record(Duration.ofMillis(outcome.latencyMs()));
    }

    /** The exact body that is stored, signed and sent. Key order is fixed. */
    private String alertBody(String event, UUID monitorId, String name, String url, IncidentRow incident) {
        Map<String, Object> monitor = new LinkedHashMap<>();
        monitor.put("id", monitorId.toString());
        monitor.put("name", name);
        monitor.put("url", url);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("event", event);
        body.put("monitor", monitor);
        body.put("incidentId", incident.id().toString());
        body.put("cause", incident.cause());
        body.put("at", Instant.now().toString());
        try {
            return mapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Claims due monitors (pushing their next_check_at forward) and runs their checks in the background. */
    @Scheduled(fixedDelayString = "${app.scheduler-tick-ms:1000}")
    public void schedulerTick() {
        int room = props.maxInFlightChecks() - inFlight.get();
        if (room <= 0) return;
        try {
            List<DueMonitor> due = tenancy.asSystem(() -> db.sql("""
                            UPDATE monitors m SET next_check_at = now() + make_interval(secs => m.interval_sec)
                             WHERE m.id IN (SELECT id FROM monitors WHERE NOT paused AND next_check_at <= now()
                                             ORDER BY next_check_at LIMIT ? FOR UPDATE SKIP LOCKED)
                            RETURNING m.id, m.url, m.method, m.timeout_ms, m.expected_status""")
                    .param(room).query(DueMonitor.class).list());
            for (DueMonitor m : due) {
                inFlight.incrementAndGet();
                checks.submit(() -> {
                    try {
                        recordCheck(m.id(), runCheck(m));
                    } catch (Exception e) {
                        log.error("[scheduler] {}: {}", m.id(), e.getMessage());
                    } finally {
                        inFlight.decrementAndGet();
                    }
                });
            }
        } catch (Exception e) {
            log.error("[scheduler] {}", e.getMessage());
        }
    }

    // --- alerts ------------------------------------------------------------------

    public String deliver(ClaimedAlert job) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(job.targetUrl()))
                    .POST(HttpRequest.BodyPublishers.ofString(job.payload()))
                    .header("Content-Type", "application/json")
                    .header("User-Agent", USER_AGENT)
                    .header("X-Pulsewatch-Event", job.event())
                    .header("X-Pulsewatch-Signature", Rules.signature(job.secret(), job.payload()))
                    .timeout(Duration.ofMillis(DELIVERY_TIMEOUT_MS))
                    .build();
            HttpResponse<Void> res = http.send(request, HttpResponse.BodyHandlers.discarding());
            return res.statusCode() >= 200 && res.statusCode() < 300 ? null : "webhook responded " + res.statusCode();
        } catch (HttpTimeoutException e) {
            return "timeout after " + DELIVERY_TIMEOUT_MS + " ms";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "connection failed: interrupted";
        } catch (Exception e) {
            return "connection failed: " + reason(e);
        }
    }

    /** Delivers due alert jobs: claim with a lease, send, then mark sent, retry later, or give up. */
    @Scheduled(fixedDelayString = "${app.scheduler-tick-ms:1000}")
    public void alertTick() {
        try {
            List<ClaimedAlert> jobs = tenancy.asSystem(() -> db.sql("""
                            UPDATE alert_jobs j SET attempts = j.attempts + 1, next_attempt_at = now() + make_interval(secs => ?)
                              FROM orgs o
                             WHERE o.id = j.org_id
                               AND j.id IN (SELECT id FROM alert_jobs WHERE status = 'pending' AND next_attempt_at <= now()
                                             ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED)
                            RETURNING j.id, j.target_url, j.payload, j.event, j.attempts, o.webhook_secret AS secret""")
                    .params(DELIVERY_LEASE_SEC, ALERT_BATCH).query(ClaimedAlert.class).list());
            var futures = jobs.stream().map(job -> checks.submit(() -> {
                String error = deliver(job);
                String outcome = error == null ? "sent" : job.attempts() >= Rules.MAX_ALERT_ATTEMPTS ? "dead" : "retry";
                tenancy.asSystem(() -> db.sql("""
                                UPDATE alert_jobs SET status = ?, last_error = ?,
                                       sent_at = CASE WHEN ? THEN now() END,
                                       next_attempt_at = now() + make_interval(secs => ?)
                                 WHERE id = ?""")
                        .params(outcome.equals("retry") ? "pending" : outcome, error, error == null,
                                Rules.backoffSeconds(job.attempts()), job.id())
                        .update());
                meters.counter("pulsewatch.alerts", "outcome", outcome).increment();
                return null;
            })).toList();
            for (var f : futures) f.get();
        } catch (Exception e) {
            log.error("[alerts] {}", e.getMessage());
        }
    }

    // --- retention -----------------------------------------------------------------

    @Scheduled(fixedRate = 3_600_000)
    public void retentionSweep() {
        try {
            int deleted = tenancy.asSystem(() -> db.sql("DELETE FROM check_results WHERE checked_at < now() - make_interval(days => ?)")
                    .param(props.retentionDays()).update());
            if (deleted > 0) log.info("[retention] deleted {} old check results", deleted);
        } catch (Exception e) {
            log.error("[retention] {}", e.getMessage());
        }
    }
}
