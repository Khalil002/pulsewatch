using System.Security.Claims;
using System.Text.Json;
using Dapper;

namespace Pulsewatch.Api;

public static class MonitorEndpoints
{
    public sealed class MonitorDto
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string Url { get; set; } = "";
        public string Method { get; set; } = "";
        public int IntervalSec { get; set; }
        public int TimeoutMs { get; set; }
        public int ExpectedStatus { get; set; }
        public string? AlertWebhookUrl { get; set; }
        public bool Paused { get; set; }
        public string Status { get; set; } = "";
        public DateTime? LastCheckedAt { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    public sealed class CheckDto
    {
        public DateTime CheckedAt { get; set; }
        public bool Ok { get; set; }
        public int? StatusCode { get; set; }
        public int LatencyMs { get; set; }
        public string? Error { get; set; }
    }

    public sealed class HourDto
    {
        public DateTime Hour { get; set; }
        public int Checks { get; set; }
        public int Failures { get; set; }
        public int AvgLatencyMs { get; set; }
    }

    public sealed class StatsDto
    {
        public int Checks { get; set; }
        public int Failures { get; set; }
        public double? UptimePercent { get; set; }
        public int? AvgLatencyMs { get; set; }
        public int? P95LatencyMs { get; set; }
        public IEnumerable<HourDto> Hourly { get; set; } = [];
    }

    public const string Columns = "id, name, url, method, interval_sec, timeout_ms, expected_status, alert_webhook_url, " +
                                  "paused, status, last_checked_at, created_at";

    public static void Map(RouteGroupBuilder api)
    {
        var monitors = api.MapGroup("/monitors");

        monitors.MapGet("/", async (ClaimsPrincipal p, Db db) => Results.Ok(await db.InOrg(Caller.From(p).OrgId, tx =>
            tx.Query<MonitorDto>($"SELECT {Columns} FROM monitors ORDER BY created_at DESC, id"))));

        monitors.MapPost("/", async (ClaimsPrincipal p, JsonElement body, Db db) =>
        {
            var caller = Caller.From(p).Require("admin");
            var fields = MonitorInput.Parse(body, partial: false);
            var args = new DynamicParameters(fields);
            args.Add("org", caller.OrgId);
            var row = await db.InOrg(caller.OrgId, tx => tx.One<MonitorDto>(
                $"""
                INSERT INTO monitors (org_id, name, url, method, interval_sec, timeout_ms, expected_status, alert_webhook_url, paused)
                VALUES (@org, @name, @url, @method, @interval_sec, @timeout_ms, @expected_status, @alert_webhook_url, @paused)
                RETURNING {Columns}
                """, args));
            return Results.Json(row, statusCode: 201);
        });

        monitors.MapGet("/{id}", async (ClaimsPrincipal p, string id, Db db) =>
        {
            var monitorId = Ids.Parse(id, "Monitor");
            return Results.Ok(await db.InOrg(Caller.From(p).OrgId, tx => Find(tx, monitorId)));
        });

        monitors.MapPatch("/{id}", async (ClaimsPrincipal p, string id, JsonElement body, Db db) =>
        {
            var caller = Caller.From(p).Require("admin");
            var monitorId = Ids.Parse(id, "Monitor");
            var changes = MonitorInput.Parse(body, partial: true);
            // Any change is checked right away, so an edited URL shows its new status quickly.
            var sets = changes.Keys.Select(c => $"{c} = @{c}").Append("next_check_at = now()");
            var args = new DynamicParameters(changes);
            args.Add("id", monitorId);
            var row = await db.InOrg(caller.OrgId, tx => tx.One<MonitorDto>(
                $"UPDATE monitors SET {string.Join(", ", sets)} WHERE id = @id RETURNING {Columns}", args));
            return row is null ? throw ApiException.NotFound("Monitor") : Results.Ok(row);
        });

        monitors.MapDelete("/{id}", async (ClaimsPrincipal p, string id, Db db) =>
        {
            var caller = Caller.From(p).Require("admin");
            var monitorId = Ids.Parse(id, "Monitor");
            var deleted = await db.InOrg(caller.OrgId, tx => tx.Execute("DELETE FROM monitors WHERE id = @monitorId", new { monitorId }));
            return deleted == 0 ? throw ApiException.NotFound("Monitor") : Results.NoContent();
        });

        monitors.MapPost("/{id}/check", async (ClaimsPrincipal p, string id, Db db) =>
        {
            var caller = Caller.From(p).Require("admin");
            var monitorId = Ids.Parse(id, "Monitor");
            var found = await db.InOrg(caller.OrgId, tx =>
                tx.Execute("UPDATE monitors SET next_check_at = now() WHERE id = @monitorId", new { monitorId }));
            return found == 0 ? throw ApiException.NotFound("Monitor") : Results.Json(new { queued = true }, statusCode: 202);
        });

        monitors.MapGet("/{id}/checks", async (ClaimsPrincipal p, string id, string? limit, Db db) =>
        {
            var monitorId = Ids.Parse(id, "Monitor");
            var n = 50;
            if (limit is not null && (!int.TryParse(limit, out n) || n is < 1 or > 500))
                throw ApiException.Validation("limit: must be an integer from 1 to 500");
            return Results.Ok(await db.InOrg(Caller.From(p).OrgId, async tx =>
            {
                await Find(tx, monitorId);
                return await tx.Query<CheckDto>(
                    """
                    SELECT checked_at, ok, status_code, latency_ms, error FROM check_results
                     WHERE monitor_id = @monitorId ORDER BY checked_at DESC, id DESC LIMIT @n
                    """, new { monitorId, n });
            }));
        });

        monitors.MapGet("/{id}/stats", async (ClaimsPrincipal p, string id, Db db) =>
        {
            var monitorId = Ids.Parse(id, "Monitor");
            return Results.Ok(await db.InOrg(Caller.From(p).OrgId, async tx =>
            {
                await Find(tx, monitorId);
                var stats = (await tx.One<StatsDto>(
                    """
                    SELECT count(*)::int AS checks,
                           (count(*) FILTER (WHERE NOT ok))::int AS failures,
                           round(100.0 * count(*) FILTER (WHERE ok) / nullif(count(*), 0), 2)::float8 AS uptime_percent,
                           round(avg(latency_ms))::int AS avg_latency_ms,
                           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms
                      FROM check_results WHERE monitor_id = @monitorId AND checked_at > now() - interval '24 hours'
                    """, new { monitorId }))!;
                stats.Hourly = await tx.Query<HourDto>(
                    """
                    SELECT date_trunc('hour', checked_at) AS hour, count(*)::int AS checks,
                           (count(*) FILTER (WHERE NOT ok))::int AS failures, round(avg(latency_ms))::int AS avg_latency_ms
                      FROM check_results WHERE monitor_id = @monitorId AND checked_at > now() - interval '24 hours'
                     GROUP BY 1 ORDER BY 1
                    """, new { monitorId });
                return stats;
            }));
        });
    }

    private static async Task<MonitorDto> Find(Tx tx, Guid id) =>
        await tx.One<MonitorDto>($"SELECT {Columns} FROM monitors WHERE id = @id", new { id }) ?? throw ApiException.NotFound("Monitor");
}

/// <summary>
/// Validates a monitor body read as raw JSON, so PATCH can tell a missing field from an explicit
/// null, and so numbers are not silently coerced from strings. Returns column -> value.
/// </summary>
public static class MonitorInput
{
    public static Dictionary<string, object?> Parse(JsonElement body, bool partial)
    {
        if (body.ValueKind != JsonValueKind.Object) throw ApiException.Validation("body: must be a JSON object");
        var output = new Dictionary<string, object?>();
        var errors = new List<string>();
        bool Has(string field, out JsonElement value) => body.TryGetProperty(field, out value);

        if (Has("name", out var name))
        {
            var v = name.ValueKind == JsonValueKind.String ? name.GetString()!.Trim() : null;
            if (v is { Length: >= 1 and <= 100 }) output["name"] = v;
            else errors.Add("name: must be 1 to 100 characters");
        }
        else if (!partial) errors.Add("name: is required");

        if (Has("url", out var url))
        {
            if (url.ValueKind == JsonValueKind.String && Rules.IsHttpUrl(url.GetString()!)) output["url"] = url.GetString();
            else errors.Add("url: must be an http:// or https:// URL");
        }
        else if (!partial) errors.Add("url: is required");

        if (Has("method", out var method))
        {
            if (method.ValueKind == JsonValueKind.String && method.GetString() is "GET" or "HEAD") output["method"] = method.GetString();
            else errors.Add("method: must be GET or HEAD");
        }
        else if (!partial) output["method"] = "GET";

        Integer("intervalSec", "interval_sec", 10, 3600, 60);
        Integer("timeoutMs", "timeout_ms", 500, 10000, 5000);
        Integer("expectedStatus", "expected_status", 100, 599, 200);

        if (Has("alertWebhookUrl", out var hook))
        {
            if (hook.ValueKind == JsonValueKind.Null) output["alert_webhook_url"] = null;
            else if (hook.ValueKind == JsonValueKind.String && Rules.IsHttpUrl(hook.GetString()!)) output["alert_webhook_url"] = hook.GetString();
            else errors.Add("alertWebhookUrl: must be an http:// or https:// URL");
        }
        else if (!partial) output["alert_webhook_url"] = null;

        if (Has("paused", out var paused))
        {
            if (paused.ValueKind is JsonValueKind.True or JsonValueKind.False) output["paused"] = paused.GetBoolean();
            else errors.Add("paused: must be a boolean");
        }
        else if (!partial) output["paused"] = false;

        if (errors.Count > 0) throw ApiException.Validation(string.Join("; ", errors));
        if (partial && output.Count == 0) throw ApiException.Validation("body: at least one field is required");
        return output;

        void Integer(string field, string column, int min, int max, int fallback)
        {
            if (!Has(field, out var value))
            {
                if (!partial) output[column] = fallback;
                return;
            }
            if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var d) && d == Math.Floor(d) && d >= min && d <= max)
                output[column] = (int)d;
            else errors.Add($"{field}: must be an integer from {min} to {max}");
        }
    }
}
