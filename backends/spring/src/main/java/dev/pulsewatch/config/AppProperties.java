package dev.pulsewatch.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String jwtSecret,
        long jwtTtlSec,
        int rateLimitMax,
        int rateLimitWindowSec,
        long cacheTtlSec,
        int retentionDays,
        long schedulerTickMs,
        int maxInFlightChecks) {}
