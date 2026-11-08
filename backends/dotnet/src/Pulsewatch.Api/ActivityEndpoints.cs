using System.Security.Claims;
using System.Text.Json;
using Npgsql;
using StackExchange.Redis;

namespace Pulsewatch.Api;

public static class ActivityEndpoints
{
    public sealed class IncidentDto
    {
        public Guid Id { get; set; }
        public Guid MonitorId { get; set; }
        public string MonitorName { get; set; } = "";
        public DateTime StartedAt { get; set; }
        public DateTime? ResolvedAt { get; set; }
        public string Cause { get; set; } = "";
    }

    public sealed class AlertDto
    {
        public Guid Id { get; set; }
        public Guid MonitorId { get; set; }
        public string Event { get; set; } = "";
        public string Status { get; set; } = "";
        public int Attempts { get; set; }
        public string? LastError { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? SentAt { get; set; }
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/incidents", async (ClaimsPrincipal p, string? status, string? monitorId, Db db) =>
        {
            if (status is not (null or "open" or "resolved")) throw ApiException.Validation("status: must be open or resolved");
            var monitor = Ids.Filter(monitorId, "monitorId");
            return Results.Ok(await db.InOrg(Caller.From(p).OrgId, tx => tx.Query<IncidentDto>(
                """
                SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at, i.cause
                  FROM incidents i JOIN monitors m ON m.id = i.monitor_id
                 WHERE (CAST(@status AS text) IS NULL OR (CAST(@status AS text) = 'open') = (i.resolved_at IS NULL))
                   AND (CAST(@monitor AS uuid) IS NULL OR i.monitor_id = CAST(@monitor AS uuid))
                 ORDER BY i.started_at DESC, i.id LIMIT 100
                """, new { status, monitor })));
        });

        api.MapGet("/alerts", async (ClaimsPrincipal p, string? monitorId, Db db) =>
        {
            var monitor = Ids.Filter(monitorId, "monitorId");
            return Results.Ok(await db.InOrg(Caller.From(p).OrgId, tx => tx.Query<AlertDto>(
                """
                SELECT id, monitor_id, event, status, attempts, last_error, created_at, sent_at
                  FROM alert_jobs WHERE (CAST(@monitor AS uuid) IS NULL OR monitor_id = CAST(@monitor AS uuid))
                 ORDER BY created_at DESC, id LIMIT 100
                """, new { monitor })));
        });
    }
}

public static class StatusEndpoints
{
    private sealed class OrgRow
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string Slug { get; set; } = "";
    }

    public sealed class EntryDto
    {
        public string Name { get; set; } = "";
        public string Status { get; set; } = "";
        public double? UptimePercent { get; set; }
        public DateTime? LastCheckedAt { get; set; }
    }

    /// <summary>Public status page. Cached briefly in Redis because it is the endpoint that gets linked and hammered.</summary>
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/status/{slug}", async (HttpContext ctx, string slug, Db db, IConnectionMultiplexer redis,
            JsonSerializerOptions json, AppOptions options) =>
        {
            slug = slug.ToLowerInvariant();
            var cache = redis.GetDatabase();
            var cached = await cache.StringGetAsync(Keys.StatusCache(slug));
            if (cached.HasValue)
            {
                ctx.Response.Headers["X-Cache"] = "HIT";
                return Results.Content(cached.ToString(), "application/json");
            }
            var org = await db.Plain(tx => tx.One<OrgRow>("SELECT id, name, slug FROM orgs WHERE slug = @slug", new { slug }))
                      ?? throw ApiException.NotFound("Status page");
            var monitors = (await db.InOrg(org.Id, tx => tx.Query<EntryDto>(
                """
                SELECT m.name, m.status,
                       (SELECT round(100.0 * count(*) FILTER (WHERE c.ok) / nullif(count(*), 0), 2)::float8
                          FROM check_results c
                         WHERE c.monitor_id = m.id AND c.checked_at > now() - interval '24 hours') AS uptime_percent,
                       m.last_checked_at
                  FROM monitors m WHERE NOT m.paused ORDER BY m.name, m.id
                """))).ToList();
            var body = JsonSerializer.Serialize(new
            {
                name = org.Name,
                slug = org.Slug,
                overall = monitors.Any(m => m.Status == "down") ? "degraded" : "operational",
                monitors,
                generatedAt = DateTime.UtcNow,
            }, json);
            await cache.StringSetAsync(Keys.StatusCache(slug), body, TimeSpan.FromSeconds(options.CacheTtlSec));
            ctx.Response.Headers["X-Cache"] = "MISS";
            return Results.Content(body, "application/json");
        });
    }
}
