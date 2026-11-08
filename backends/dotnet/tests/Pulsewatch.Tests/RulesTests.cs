using System.Text.RegularExpressions;
using Pulsewatch.Api;
using Xunit;

namespace Pulsewatch.Tests;

/// <summary>The same values are pinned in the Express and Spring unit tests.</summary>
public class RulesTests
{
    [Fact]
    public void SlugifiesNames()
    {
        Assert.Equal("acme-corp", Rules.Slugify("  Acme Corp!! "));
        Assert.Equal("n-code-labs", Rules.Slugify("Ünïcode ☃ Labs"));
        Assert.Equal("org", Rules.Slugify("!!!"));
        Assert.Equal(new string('a', 39), Rules.Slugify(new string('a', 39) + " b"));
        Assert.Matches(new Regex("^acme-corp-[a-z0-9]{4}$"), Rules.OrgSlug("Acme Corp"));
    }

    [Fact]
    public void StoresApiKeysAsSha256()
    {
        var key = Rules.NewApiKey();
        Assert.Matches(new Regex("^pw_[0-9a-f]{48}$"), key.Key);
        Assert.Equal(key.Key[..10], key.Prefix);
        Assert.Equal(Rules.Sha256Hex(key.Key), key.Hash);
        Assert.Equal("7385aabf0686675cf3f41051fc92d688d2c06abb5915f83dcb12b1ca2abfece7", Rules.Sha256Hex("pw_test"));
    }

    [Fact]
    public void SignsWebhookBodies() =>
        Assert.Equal("sha256=c4ca1ce2fb7ca855eac003c9d72f6eb2314d5a15e497849c61c8f04b203a7557",
            Rules.Signature("topsecret", "{\"event\":\"monitor.down\"}"));

    [Fact]
    public void SerialisesThePayloadWithAFixedKeyOrder() =>
        Assert.Equal(
            "{\"event\":\"monitor.up\",\"monitor\":{\"id\":\"00000000-0000-0000-0000-000000000001\",\"name\":\"API\",\"url\":\"https://x\"}," +
            "\"incidentId\":\"00000000-0000-0000-0000-000000000002\",\"cause\":\"c\",\"at\":\"2026-01-01T00:00:00.000Z\"}",
            Rules.AlertBody("monitor.up", Guid.Parse("00000000-0000-0000-0000-000000000001"), "API", "https://x",
                Guid.Parse("00000000-0000-0000-0000-000000000002"), "c", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)));

    [Fact]
    public void BacksOffExponentially() =>
        Assert.Equal([2L, 4L, 8L, 16L], new[] { 1, 2, 3, 4 }.Select(Rules.BackoffSeconds));

    [Fact]
    public void DescribesCheckOutcomes()
    {
        Assert.Equal(new Outcome(true, 200, 12, null), Rules.Response(200, 200, 12));
        Assert.Equal("expected 200 but got 503", Rules.Response(503, 200, 12).Error);
        Assert.Equal("timeout after 1000 ms", Rules.Timeout(1000, 1001).Error);
        Assert.Equal("connection failed: ECONNREFUSED", Rules.ConnectionFailed("ECONNREFUSED", 3).Error);
    }

    [Fact]
    public void OpensAndResolvesIncidents()
    {
        Assert.Equal(new Transition("down", true, false), Rules.Next("pending", false));
        Assert.Equal(new Transition("down", true, false), Rules.Next("up", false));
        Assert.Equal(new Transition("down", false, false), Rules.Next("down", false));
        Assert.Equal(new Transition("up", false, true), Rules.Next("down", true));
        Assert.Equal(new Transition("up", false, false), Rules.Next("pending", true));
    }

    [Theory]
    [InlineData("https://example.com/health", true)]
    [InlineData("http://testbed:9000/t/x", true)]
    [InlineData("ftp://example.com", false)]
    [InlineData("not a url", false)]
    public void AcceptsOnlyHttpUrls(string url, bool ok) => Assert.Equal(ok, Rules.IsHttpUrl(url));
}
