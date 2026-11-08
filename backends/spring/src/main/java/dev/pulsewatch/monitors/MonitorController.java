package dev.pulsewatch.monitors;

import com.fasterxml.jackson.databind.JsonNode;
import dev.pulsewatch.auth.Caller;
import dev.pulsewatch.auth.Role;
import dev.pulsewatch.config.Tenancy;
import dev.pulsewatch.web.ApiException;
import dev.pulsewatch.web.Ids;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/monitors")
public class MonitorController {
    public record Monitor(UUID id, String name, String url, String method, int intervalSec, int timeoutMs,
            int expectedStatus, String alertWebhookUrl, boolean paused, String status, OffsetDateTime lastCheckedAt,
            OffsetDateTime createdAt) {}

    public record CheckResult(OffsetDateTime checkedAt, boolean ok, Integer statusCode, int latencyMs, String error) {}

    public record Hour(OffsetDateTime hour, int checks, int failures, int avgLatencyMs) {}

    public record Summary(int checks, int failures, Double uptimePercent, Integer avgLatencyMs, Integer p95LatencyMs) {}

    public record Stats(int checks, int failures, Double uptimePercent, Integer avgLatencyMs, Integer p95LatencyMs,
            List<Hour> hourly) {}

    static final String COLUMNS = "id, name, url, method, interval_sec, timeout_ms, expected_status, alert_webhook_url, "
            + "paused, status, last_checked_at, created_at";

    private final JdbcClient db;
    private final Tenancy tenancy;

    public MonitorController(JdbcClient db, Tenancy tenancy) {
        this.db = db;
        this.tenancy = tenancy;
    }

    @GetMapping
    public List<Monitor> list() {
        return tenancy.inOrg(Caller.current().orgId(), () ->
                db.sql("SELECT " + COLUMNS + " FROM monitors ORDER BY created_at DESC, id").query(Monitor.class).list());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Monitor create(@RequestBody(required = false) JsonNode body) {
        Caller caller = Caller.current().require(Role.ADMIN);
        Map<String, Object> m = MonitorInput.parse(body, false);
        return tenancy.inOrg(caller.orgId(), () -> db.sql("""
                        INSERT INTO monitors (org_id, name, url, method, interval_sec, timeout_ms, expected_status,
                                              alert_webhook_url, paused)
                        VALUES (:org, :name, :url, :method, :interval_sec, :timeout_ms, :expected_status,
                                :alert_webhook_url, :paused)
                        RETURNING\s""" + COLUMNS)
                .param("org", caller.orgId()).params(m).query(Monitor.class).single());
    }

    @GetMapping("/{id}")
    public Monitor get(@PathVariable String id) {
        UUID monitorId = Ids.parse(id, "Monitor");
        return tenancy.inOrg(Caller.current().orgId(), () -> find(monitorId));
    }

    @PatchMapping("/{id}")
    public Monitor patch(@PathVariable String id, @RequestBody(required = false) JsonNode body) {
        Caller caller = Caller.current().require(Role.ADMIN);
        UUID monitorId = Ids.parse(id, "Monitor");
        Map<String, Object> changes = MonitorInput.parse(body, true);
        List<String> sets = new ArrayList<>();
        changes.keySet().forEach(column -> sets.add(column + " = :" + column));
        // Any change is checked right away, so an edited URL shows its new status quickly.
        sets.add("next_check_at = now()");
        return tenancy.inOrg(caller.orgId(), () -> db.sql(
                        "UPDATE monitors SET " + String.join(", ", sets) + " WHERE id = :id RETURNING " + COLUMNS)
                .param("id", monitorId).params(changes).query(Monitor.class).optional()
                .orElseThrow(() -> ApiException.notFound("Monitor")));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        Caller caller = Caller.current().require(Role.ADMIN);
        UUID monitorId = Ids.parse(id, "Monitor");
        int deleted = tenancy.inOrg(caller.orgId(), () -> db.sql("DELETE FROM monitors WHERE id = ?").param(monitorId).update());
        if (deleted == 0) throw ApiException.notFound("Monitor");
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{id}/check")
    public ResponseEntity<Map<String, Boolean>> checkNow(@PathVariable String id) {
        Caller caller = Caller.current().require(Role.ADMIN);
        UUID monitorId = Ids.parse(id, "Monitor");
        int found = tenancy.inOrg(caller.orgId(), () ->
                db.sql("UPDATE monitors SET next_check_at = now() WHERE id = ?").param(monitorId).update());
        if (found == 0) throw ApiException.notFound("Monitor");
        return ResponseEntity.accepted().body(Map.of("queued", true));
    }

    @GetMapping("/{id}/checks")
    public List<CheckResult> checks(@PathVariable String id, @RequestParam(required = false) String limit) {
        UUID monitorId = Ids.parse(id, "Monitor");
        int n = 50;
        if (limit != null) {
            try {
                n = Integer.parseInt(limit);
            } catch (NumberFormatException e) {
                n = -1;
            }
            if (n < 1 || n > 500) throw ApiException.invalid("limit: must be an integer from 1 to 500");
        }
        int max = n;
        return tenancy.inOrg(Caller.current().orgId(), () -> {
            find(monitorId);
            return db.sql("""
                            SELECT checked_at, ok, status_code, latency_ms, error FROM check_results
                             WHERE monitor_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?""")
                    .params(monitorId, max).query(CheckResult.class).list();
        });
    }

    @GetMapping("/{id}/stats")
    public Stats stats(@PathVariable String id) {
        UUID monitorId = Ids.parse(id, "Monitor");
        return tenancy.inOrg(Caller.current().orgId(), () -> {
            find(monitorId);
            Summary s = db.sql("""
                            SELECT count(*)::int AS checks,
                                   (count(*) FILTER (WHERE NOT ok))::int AS failures,
                                   round(100.0 * count(*) FILTER (WHERE ok) / nullif(count(*), 0), 2)::float8 AS uptime_percent,
                                   round(avg(latency_ms))::int AS avg_latency_ms,
                                   round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms
                              FROM check_results WHERE monitor_id = ? AND checked_at > now() - interval '24 hours'""")
                    .param(monitorId).query(Summary.class).single();
            List<Hour> hourly = db.sql("""
                            SELECT date_trunc('hour', checked_at) AS hour, count(*)::int AS checks,
                                   (count(*) FILTER (WHERE NOT ok))::int AS failures,
                                   round(avg(latency_ms))::int AS avg_latency_ms
                              FROM check_results WHERE monitor_id = ? AND checked_at > now() - interval '24 hours'
                             GROUP BY 1 ORDER BY 1""")
                    .param(monitorId).query(Hour.class).list();
            return new Stats(s.checks(), s.failures(), s.uptimePercent(), s.avgLatencyMs(), s.p95LatencyMs(), hourly);
        });
    }

    private Monitor find(UUID id) {
        return db.sql("SELECT " + COLUMNS + " FROM monitors WHERE id = ?").param(id).query(Monitor.class).optional()
                .orElseThrow(() -> ApiException.notFound("Monitor"));
    }
}
