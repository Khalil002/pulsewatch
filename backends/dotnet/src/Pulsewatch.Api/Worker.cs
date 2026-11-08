using System.Diagnostics;
using System.Text;
using Prometheus;

namespace Pulsewatch.Api;

/// <summary>Same metric names in every backend, so one Grafana dashboard fits all of them.</summary>
public static class PulseMetrics
{
    public static readonly Counter Checks = Metrics.CreateCounter("pulsewatch_checks_total", "Checks run, by result", "result");
    public static readonly Histogram CheckDuration = Metrics.CreateHistogram("pulsewatch_check_duration_seconds",
        "Time to the target's response headers",
        new HistogramConfiguration { Buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] });
    public static readonly Counter Alerts = Metrics.CreateCounter("pulsewatch_alerts_total", "Alert delivery attempts, by outcome", "outcome");
}

/// <summary>
/// Background work that runs in every replica. Rows are claimed with FOR UPDATE SKIP LOCKED, so
/// replicas never run the same check or deliver the same alert twice.
/// </summary>
public sealed class Worker(Db db, AppOptions options, IHttpClientFactory httpFactory, ILogger<Worker> log) : BackgroundService
{
    public const string HttpClientName = "checks";
    private const string UserAgent = "pulsewatch/1.0 (dotnet)";
    private const int DeliveryTimeoutMs = 5000;
    /// <summary>A claimed delivery is invisible to other workers for this long, in case this one dies mid-request.</summary>
    private const int DeliveryLeaseSec = 60;
    private const int AlertBatch = 10;

    private int _inFlight;

    public sealed class DueMonitor
    {
        public Guid Id { get; set; }
        public string Url { get; set; } = "";
        public string Method { get; set; } = "";
        public int TimeoutMs { get; set; }
        public int ExpectedStatus { get; set; }
    }

    private sealed class LockedMonitor
    {
        public Guid OrgId { get; set; }
        public string Name { get; set; } = "";
        public string Url { get; set; } = "";
        public string Status { get; set; } = "";
        public string? AlertWebhookUrl { get; set; }
    }

    private sealed class IncidentRow
    {
        public Guid Id { get; set; }
        public string Cause { get; set; } = "";
    }

    public sealed class ClaimedAlert
    {
        public Guid Id { get; set; }
        public string TargetUrl { get; set; } = "";
        public string Payload { get; set; } = "";
        public string Event { get; set; } = "";
        public int Attempts { get; set; }
        public string Secret { get; set; } = "";
    }

    protected override Task ExecuteAsync(CancellationToken stop) => Task.WhenAll(
        Loop("scheduler", options.SchedulerTickMs, SchedulerTick, stop),
        Loop("alerts", options.SchedulerTickMs, AlertTick, stop),
        Loop("retention", 3_600_000, RetentionSweep, stop));

    private async Task Loop(string name, int everyMs, Func<Task> tick, CancellationToken stop)
    {
        await Task.Yield();
        while (!stop.IsCancellationRequested)
        {
            try { await tick(); }
            catch (Exception e) { log.LogError("[{Name}] {Message}", name, e.Message); }
            try { await Task.Delay(everyMs, stop); } catch (OperationCanceledException) { }
        }
    }

    // --- checks ------------------------------------------------------------------

    public async Task<Outcome> RunCheck(DueMonitor m)
    {
        var watch = Stopwatch.StartNew();
        int Elapsed() => (int)watch.ElapsedMilliseconds;
        using var cts = new CancellationTokenSource(m.TimeoutMs);
        try
        {
            using var request = new HttpRequestMessage(new HttpMethod(m.Method), m.Url);
            request.Headers.UserAgent.ParseAdd(UserAgent);
            using var res = await httpFactory.CreateClient(HttpClientName)
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            return Rules.Response((int)res.StatusCode, m.ExpectedStatus, Elapsed());
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            return Rules.Timeout(m.TimeoutMs, Elapsed());
        }
        catch (Exception e)
        {
            return Rules.ConnectionFailed(Reason(e), Elapsed());
        }
    }

    private static string Reason(Exception e) => (e.InnerException ?? e).Message;

    /// <summary>Stores a result and applies its consequences (status, incident, alert) in one transaction.</summary>
    public async Task RecordCheck(Guid monitorId, Outcome outcome)
    {
        await db.AsSystem<object?>(async tx =>
        {
            var m = await tx.One<LockedMonitor>(
                "SELECT org_id, name, url, status, alert_webhook_url FROM monitors WHERE id = @monitorId FOR UPDATE", new { monitorId });
            if (m is null) return null; // deleted while the check ran
            await tx.Execute(
                """
                INSERT INTO check_results (monitor_id, org_id, ok, status_code, latency_ms, error)
                VALUES (@monitorId, @org, @ok, @statusCode, @latency, @error)
                """,
                new { monitorId, org = m.OrgId, ok = outcome.Ok, statusCode = outcome.StatusCode, latency = outcome.LatencyMs, error = outcome.Error });
            var next = Rules.Next(m.Status, outcome.Ok);
            await tx.Execute("UPDATE monitors SET status = @status, last_checked_at = now() WHERE id = @monitorId",
                new { status = next.Status, monitorId });

            IncidentRow? incident = null;
            string? evt = null;
            if (next.Opens)
            {
                incident = await tx.One<IncidentRow>(
                    """
                    INSERT INTO incidents (monitor_id, org_id, cause) VALUES (@monitorId, @org, @cause)
                    ON CONFLICT (monitor_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id, cause
                    """, new { monitorId, org = m.OrgId, cause = outcome.Error });
                evt = "monitor.down";
            }
            else if (next.Resolves)
            {
                incident = await tx.One<IncidentRow>(
                    "UPDATE incidents SET resolved_at = now() WHERE monitor_id = @monitorId AND resolved_at IS NULL RETURNING id, cause",
                    new { monitorId });
                evt = "monitor.up";
            }
            if (incident is not null && evt is not null && m.AlertWebhookUrl is not null)
            {
                await tx.Execute(
                    """
                    INSERT INTO alert_jobs (org_id, monitor_id, incident_id, event, target_url, payload)
                    VALUES (@org, @monitorId, @incident, @evt, @target, @payload)
                    """,
                    new
                    {
                        org = m.OrgId, monitorId, incident = incident.Id, evt, target = m.AlertWebhookUrl,
                        payload = Rules.AlertBody(evt, monitorId, m.Name, m.Url, incident.Id, incident.Cause, DateTime.UtcNow),
                    });
            }
            return null;
        });
        PulseMetrics.Checks.WithLabels(outcome.Ok ? "success" : "failure").Inc();
        PulseMetrics.CheckDuration.Observe(outcome.LatencyMs / 1000.0);
    }

    /// <summary>Claims due monitors (pushing their next_check_at forward) and runs their checks in the background.</summary>
    public async Task SchedulerTick()
    {
        var room = options.MaxInFlightChecks - Volatile.Read(ref _inFlight);
        if (room <= 0) return;
        var due = await db.AsSystem(tx => tx.Query<DueMonitor>(
            """
            UPDATE monitors m SET next_check_at = now() + make_interval(secs => m.interval_sec)
             WHERE m.id IN (SELECT id FROM monitors WHERE NOT paused AND next_check_at <= now()
                             ORDER BY next_check_at LIMIT @room FOR UPDATE SKIP LOCKED)
            RETURNING m.id, m.url, m.method, m.timeout_ms, m.expected_status
            """, new { room }));
        foreach (var m in due)
        {
            Interlocked.Increment(ref _inFlight);
            _ = Task.Run(async () =>
            {
                try { await RecordCheck(m.Id, await RunCheck(m)); }
                catch (Exception e) { log.LogError("[scheduler] {Id}: {Message}", m.Id, e.Message); }
                finally { Interlocked.Decrement(ref _inFlight); }
            });
        }
    }

    // --- alerts ------------------------------------------------------------------

    public async Task<string?> Deliver(ClaimedAlert job)
    {
        using var cts = new CancellationTokenSource(DeliveryTimeoutMs);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, job.TargetUrl)
            {
                Content = new StringContent(job.Payload, new UTF8Encoding(false), "application/json"),
            };
            request.Headers.UserAgent.ParseAdd(UserAgent);
            request.Headers.Add("X-Pulsewatch-Event", job.Event);
            request.Headers.Add("X-Pulsewatch-Signature", Rules.Signature(job.Secret, job.Payload));
            using var res = await httpFactory.CreateClient(HttpClientName).SendAsync(request, cts.Token);
            return res.IsSuccessStatusCode ? null : $"webhook responded {(int)res.StatusCode}";
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            return $"timeout after {DeliveryTimeoutMs} ms";
        }
        catch (Exception e)
        {
            return $"connection failed: {Reason(e)}";
        }
    }

    /// <summary>Delivers due alert jobs: claim with a lease, send, then mark sent, retry later, or give up.</summary>
    public async Task AlertTick()
    {
        var jobs = await db.AsSystem(tx => tx.Query<ClaimedAlert>(
            """
            UPDATE alert_jobs j SET attempts = j.attempts + 1, next_attempt_at = now() + make_interval(secs => @lease)
              FROM orgs o
             WHERE o.id = j.org_id
               AND j.id IN (SELECT id FROM alert_jobs WHERE status = 'pending' AND next_attempt_at <= now()
                             ORDER BY next_attempt_at LIMIT @batch FOR UPDATE SKIP LOCKED)
            RETURNING j.id, j.target_url, j.payload, j.event, j.attempts, o.webhook_secret AS secret
            """, new { lease = DeliveryLeaseSec, batch = AlertBatch }));
        await Task.WhenAll(jobs.Select(async job =>
        {
            var error = await Deliver(job);
            var outcome = error is null ? "sent" : job.Attempts >= Rules.MaxAlertAttempts ? "dead" : "retry";
            await db.AsSystem(tx => tx.Execute(
                """
                UPDATE alert_jobs SET status = @status, last_error = @error,
                       sent_at = CASE WHEN @sent THEN now() END,
                       next_attempt_at = now() + make_interval(secs => @backoff)
                 WHERE id = @id
                """,
                new { status = outcome == "retry" ? "pending" : outcome, error, sent = error is null,
                      backoff = (double)Rules.BackoffSeconds(job.Attempts), id = job.Id }));
            PulseMetrics.Alerts.WithLabels(outcome).Inc();
        }));
    }

    // --- retention -----------------------------------------------------------------

    public async Task RetentionSweep()
    {
        var deleted = await db.AsSystem(tx => tx.Execute(
            "DELETE FROM check_results WHERE checked_at < now() - make_interval(days => @days)", new { days = options.RetentionDays }));
        if (deleted > 0) log.LogInformation("[retention] deleted {Count} old check results", deleted);
    }
}
