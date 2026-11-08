package dev.pulsewatch.status;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.pulsewatch.config.AppProperties;
import dev.pulsewatch.config.Tenancy;
import dev.pulsewatch.web.ApiException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Public status page. Cached briefly in Redis because it is the endpoint that gets linked and hammered. */
@RestController
public class StatusController {
    private record OrgRow(UUID id, String name, String slug) {}

    public record Entry(String name, String status, Double uptimePercent, OffsetDateTime lastCheckedAt) {}

    private final JdbcClient db;
    private final Tenancy tenancy;
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final AppProperties props;

    public StatusController(JdbcClient db, Tenancy tenancy, StringRedisTemplate redis, ObjectMapper mapper, AppProperties props) {
        this.db = db;
        this.tenancy = tenancy;
        this.redis = redis;
        this.mapper = mapper;
        this.props = props;
    }

    @GetMapping("/api/status/{slug}")
    public ResponseEntity<String> status(@PathVariable String slug) throws JsonProcessingException {
        String key = "pw:status:" + slug.toLowerCase(Locale.ROOT);
        String cached = redis.opsForValue().get(key);
        if (cached != null) {
            return ResponseEntity.ok().header("X-Cache", "HIT").contentType(MediaType.APPLICATION_JSON).body(cached);
        }
        OrgRow org = db.sql("SELECT id, name, slug FROM orgs WHERE slug = ?").param(slug.toLowerCase(Locale.ROOT))
                .query(OrgRow.class).optional().orElseThrow(() -> ApiException.notFound("Status page"));
        List<Entry> monitors = tenancy.inOrg(org.id(), () -> db.sql("""
                        SELECT m.name, m.status,
                               (SELECT round(100.0 * count(*) FILTER (WHERE c.ok) / nullif(count(*), 0), 2)::float8
                                  FROM check_results c
                                 WHERE c.monitor_id = m.id AND c.checked_at > now() - interval '24 hours') AS uptime_percent,
                               m.last_checked_at
                          FROM monitors m WHERE NOT m.paused ORDER BY m.name, m.id""")
                .query(Entry.class).list());
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("name", org.name());
        page.put("slug", org.slug());
        page.put("overall", monitors.stream().anyMatch(m -> "down".equals(m.status())) ? "degraded" : "operational");
        page.put("monitors", monitors);
        page.put("generatedAt", Instant.now().toString());
        String body = mapper.writeValueAsString(page);
        redis.opsForValue().set(key, body, Duration.ofSeconds(props.cacheTtlSec()));
        return ResponseEntity.ok().header("X-Cache", "MISS").contentType(MediaType.APPLICATION_JSON).body(body);
    }
}
