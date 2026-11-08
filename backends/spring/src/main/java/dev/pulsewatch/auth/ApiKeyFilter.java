package dev.pulsewatch.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.pulsewatch.config.AppProperties;
import dev.pulsewatch.web.ErrorCode;
import dev.pulsewatch.web.Problems;
import dev.pulsewatch.worker.Rules;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** Authenticates X-API-Key requests and applies the per-key rate limit (shared across replicas via Redis). */
public class ApiKeyFilter extends OncePerRequestFilter {
    private record Key(UUID keyId, UUID keyOrgId) {}

    private final JdbcClient db;
    private final StringRedisTemplate redis;
    private final AppProperties props;
    private final ObjectMapper mapper;

    public ApiKeyFilter(JdbcClient db, StringRedisTemplate redis, AppProperties props, ObjectMapper mapper) {
        this.db = db;
        this.redis = redis;
        this.props = props;
        this.mapper = mapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String header = req.getHeader("X-API-Key");
        if (header == null || header.isEmpty()) {
            chain.doFilter(req, res);
            return;
        }
        // api_key_lookup is SECURITY DEFINER: the org isn't known yet, so it can't go through row-level security.
        var key = db.sql("SELECT key_id, key_org_id FROM api_key_lookup(?)")
                .param(Rules.sha256Hex(header)).query(Key.class).optional();
        if (key.isEmpty()) {
            Problems.write(res, mapper, 401, ErrorCode.UNAUTHORIZED, "Invalid or revoked API key", null);
            return;
        }
        long now = System.currentTimeMillis() / 1000;
        long window = now / props.rateLimitWindowSec();
        String counter = "pw:rl:" + key.get().keyId() + ":" + window;
        Long count = redis.opsForValue().increment(counter);
        if (count != null && count == 1) redis.expire(counter, Duration.ofSeconds(props.rateLimitWindowSec()));
        if (count != null && count > props.rateLimitMax()) {
            long retryAfter = Math.max(1, (window + 1) * props.rateLimitWindowSec() - now);
            res.setHeader("Retry-After", String.valueOf(retryAfter));
            Problems.write(res, mapper, 429, ErrorCode.RATE_LIMITED, "Too many requests for this API key",
                    "limit is " + props.rateLimitMax() + " per " + props.rateLimitWindowSec() + "s");
            return;
        }
        SecurityContextHolder.getContext().setAuthentication(new ApiKeyAuthentication(key.get().keyId(), key.get().keyOrgId()));
        chain.doFilter(req, res);
    }
}
