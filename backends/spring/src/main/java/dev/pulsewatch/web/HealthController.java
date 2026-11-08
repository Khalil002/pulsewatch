package dev.pulsewatch.web;

import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    private final JdbcClient db;
    private final StringRedisTemplate redis;

    public HealthController(JdbcClient db, StringRedisTemplate redis) {
        this.db = db;
        this.redis = redis;
    }

    @GetMapping("/api/health")
    public ResponseEntity<Map<String, String>> health() {
        try {
            db.sql("SELECT 1").query(Integer.class).single();
            try (var connection = redis.getConnectionFactory().getConnection()) {
                connection.ping();
            }
            return ResponseEntity.ok(Map.of("status", "ok", "backend", "spring"));
        } catch (Exception e) {
            return ResponseEntity.status(503).body(Map.of("status", "degraded", "backend", "spring"));
        }
    }
}
