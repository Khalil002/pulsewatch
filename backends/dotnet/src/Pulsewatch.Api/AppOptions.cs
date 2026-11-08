namespace Pulsewatch.Api;

/// <summary>Settings read from the same environment variables every backend uses.</summary>
public sealed record AppOptions
{
    public int Port { get; init; } = 8000;
    public string ConnectionString { get; init; } = "";
    public string RedisHost { get; init; } = "localhost";
    public int RedisPort { get; init; } = 6379;
    public string JwtSecret { get; init; } = "change-me-to-a-long-random-secret-of-32-bytes";
    public int JwtTtlSec { get; init; } = 43200;
    public int RateLimitMax { get; init; } = 60;
    public int RateLimitWindowSec { get; init; } = 60;
    public int CacheTtlSec { get; init; } = 5;
    public int RetentionDays { get; init; } = 30;
    public int SchedulerTickMs { get; init; } = 1000;
    public int MaxInFlightChecks { get; init; } = 50;
    public string? OtlpEndpoint { get; init; }
    public string ServiceName { get; init; } = "pulsewatch-dotnet";

    public static AppOptions FromEnvironment()
    {
        static string Str(string name, string fallback) =>
            Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : fallback;
        static int Int(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : fallback;

        return new AppOptions
        {
            Port = Int("PORT", 8000),
            ConnectionString = $"Host={Str("DB_HOST", "localhost")};Port={Int("DB_PORT", 5432)};Database={Str("DB_NAME", "pulsewatch")};" +
                               $"Username={Str("DB_USER", "pulsewatch_app")};Password={Str("DB_PASSWORD", "pulsewatch_app")};Maximum Pool Size=20",
            RedisHost = Str("REDIS_HOST", "localhost"),
            RedisPort = Int("REDIS_PORT", 6379),
            JwtSecret = Str("JWT_SECRET", "change-me-to-a-long-random-secret-of-32-bytes"),
            JwtTtlSec = Int("JWT_TTL_SEC", 43200),
            RateLimitMax = Int("RATE_LIMIT_MAX", 60),
            RateLimitWindowSec = Int("RATE_LIMIT_WINDOW_SEC", 60),
            CacheTtlSec = Int("CACHE_TTL_SEC", 5),
            RetentionDays = Int("RETENTION_DAYS", 30),
            SchedulerTickMs = Int("SCHEDULER_TICK_MS", 1000),
            MaxInFlightChecks = Int("MAX_INFLIGHT_CHECKS", 50),
            OtlpEndpoint = Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT") is { Length: > 0 } e ? e.TrimEnd('/') : null,
            ServiceName = Str("OTEL_SERVICE_NAME", "pulsewatch-dotnet"),
        };
    }
}

/// <summary>Redis key names shared by all three backends.</summary>
public static class Keys
{
    public static string StatusCache(string slug) => $"pw:status:{slug}";
    public static string RateLimit(Guid keyId, long window) => $"pw:rl:{keyId}:{window}";
}
