using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Pulsewatch.Api;

public sealed record Outcome(bool Ok, int? StatusCode, int LatencyMs, string? Error);

public sealed record Transition(string Status, bool Opens, bool Resolves);

public sealed record NewApiKey(string Key, string Prefix, string Hash);

/// <summary>Rules every backend implements identically. The unit tests in each backend pin the same values.</summary>
public static partial class Rules
{
    public const int MaxAlertAttempts = 5;
    private const string SlugChars = "abcdefghijklmnopqrstuvwxyz0123456789";

    /// <summary>Seconds to wait before retrying a delivery that has failed <paramref name="attempts"/> times.</summary>
    public static long BackoffSeconds(int attempts) => 1L << attempts;

    [GeneratedRegex("[^a-z0-9]+")] private static partial Regex NonSlug();

    /// <summary>"Acme Corp!" -> "acme-corp". Non-ASCII letters are dropped; an empty result becomes "org".</summary>
    public static string Slugify(string name)
    {
        var slug = NonSlug().Replace(name.ToLowerInvariant(), "-").Trim('-');
        if (slug.Length > 40) slug = slug[..40];
        slug = slug.TrimEnd('-');
        return slug.Length == 0 ? "org" : slug;
    }

    /// <summary>Public slug: slugified name plus 4 random characters, so names don't have to be unique.</summary>
    public static string OrgSlug(string name) =>
        $"{Slugify(name)}-{new string(Enumerable.Range(0, 4).Select(_ => SlugChars[RandomNumberGenerator.GetInt32(SlugChars.Length)]).ToArray())}";

    public static string Sha256Hex(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    /// <summary>API keys look like pw_ + 48 hex chars. Only the SHA-256 is stored.</summary>
    public static NewApiKey NewApiKey()
    {
        var key = "pw_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        return new NewApiKey(key, key[..10], Sha256Hex(key));
    }

    /// <summary>Value of the X-Pulsewatch-Signature header for a raw webhook body.</summary>
    public static string Signature(string secret, string body) =>
        "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant();

    public static Outcome Response(int statusCode, int expected, int latencyMs) =>
        new(statusCode == expected, statusCode, latencyMs, statusCode == expected ? null : $"expected {expected} but got {statusCode}");

    public static Outcome Timeout(int timeoutMs, int latencyMs) => new(false, null, latencyMs, $"timeout after {timeoutMs} ms");

    public static Outcome ConnectionFailed(string reason, int latencyMs) => new(false, null, latencyMs, $"connection failed: {reason}");

    /// <summary>What a check result does to a monitor: its new status, and whether an incident opens or resolves.</summary>
    public static Transition Next(string previous, bool ok) =>
        ok ? new Transition("up", false, previous == "down") : new Transition("down", previous != "down", false);

    /// <summary>The exact body that is stored, signed and sent. Key order is fixed.</summary>
    public static string AlertBody(string evt, Guid monitorId, string name, string url, Guid incidentId, string cause, DateTime at) =>
        JsonSerializer.Serialize(new
        {
            @event = evt,
            monitor = new { id = monitorId.ToString(), name, url },
            incidentId = incidentId.ToString(),
            cause,
            at = Iso(at),
        });

    public static string Iso(DateTime utc) => utc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    [GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]+$")] private static partial Regex EmailShape();
    public static bool IsEmail(string value) => value.Length <= 254 && EmailShape().IsMatch(value);

    public static bool IsHttpUrl(string value) =>
        value.Length <= 2048
        && Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
        && !string.IsNullOrEmpty(uri.Host)
        && value.StartsWith(uri.Scheme + "://", StringComparison.OrdinalIgnoreCase);
}
