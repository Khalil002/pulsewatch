package dev.pulsewatch.activity;

import dev.pulsewatch.auth.Caller;
import dev.pulsewatch.config.Tenancy;
import dev.pulsewatch.web.ApiException;
import dev.pulsewatch.web.Ids;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ActivityController {
    public record Incident(UUID id, UUID monitorId, String monitorName, OffsetDateTime startedAt, OffsetDateTime resolvedAt,
            String cause) {}

    public record AlertDelivery(UUID id, UUID monitorId, String event, String status, int attempts, String lastError,
            OffsetDateTime createdAt, OffsetDateTime sentAt) {}

    private final JdbcClient db;
    private final Tenancy tenancy;

    public ActivityController(JdbcClient db, Tenancy tenancy) {
        this.db = db;
        this.tenancy = tenancy;
    }

    private static UUID monitorFilter(String value) {
        if (value == null) return null;
        if (!Ids.isUuid(value)) throw ApiException.invalid("monitorId: must be a UUID");
        return UUID.fromString(value);
    }

    @GetMapping("/api/incidents")
    public List<Incident> incidents(@RequestParam(required = false) String status,
            @RequestParam(required = false) String monitorId) {
        if (status != null && !status.equals("open") && !status.equals("resolved")) {
            throw ApiException.invalid("status: must be open or resolved");
        }
        UUID monitor = monitorFilter(monitorId);
        return tenancy.inOrg(Caller.current().orgId(), () -> db.sql("""
                        SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at, i.cause
                          FROM incidents i JOIN monitors m ON m.id = i.monitor_id
                         WHERE (CAST(:status AS text) IS NULL OR (CAST(:status AS text) = 'open') = (i.resolved_at IS NULL))
                           AND (CAST(:monitor AS uuid) IS NULL OR i.monitor_id = CAST(:monitor AS uuid))
                         ORDER BY i.started_at DESC, i.id LIMIT 100""")
                .param("status", status).param("monitor", monitor).query(Incident.class).list());
    }

    @GetMapping("/api/alerts")
    public List<AlertDelivery> alerts(@RequestParam(required = false) String monitorId) {
        UUID monitor = monitorFilter(monitorId);
        return tenancy.inOrg(Caller.current().orgId(), () -> db.sql("""
                        SELECT id, monitor_id, event, status, attempts, last_error, created_at, sent_at
                          FROM alert_jobs WHERE (CAST(:monitor AS uuid) IS NULL OR monitor_id = CAST(:monitor AS uuid))
                         ORDER BY created_at DESC, id LIMIT 100""")
                .param("monitor", monitor).query(AlertDelivery.class).list());
    }
}
