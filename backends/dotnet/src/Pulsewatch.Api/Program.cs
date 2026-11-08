using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http.Json;
using Npgsql;
using OpenTelemetry.Exporter;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Prometheus;
using Pulsewatch.Api;
using StackExchange.Redis;

var options = AppOptions.FromEnvironment();
DefaultTypeMap.MatchNamesWithUnderscores = true;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{options.Port}");
builder.Logging.AddSimpleConsole(o => o.SingleLine = true);

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
json.Converters.Add(new UtcMillisConverter());
builder.Services.Configure<JsonOptions>(o => o.SerializerOptions.Converters.Add(new UtcMillisConverter()));
builder.Services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);

builder.Services.AddSingleton(options);
builder.Services.AddSingleton(json);
var dataSourceBuilder = new NpgsqlDataSourceBuilder(options.ConnectionString);
builder.Services.AddSingleton(dataSourceBuilder.Build());
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<IConnectionMultiplexer>(
    ConnectionMultiplexer.Connect($"{options.RedisHost}:{options.RedisPort},abortConnect=false"));
builder.Services.AddSingleton<TokenService>();
builder.Services.AddHttpClient(Worker.HttpClientName, c => c.Timeout = Timeout.InfiniteTimeSpan)
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        AllowAutoRedirect = false, // a check sees the redirect itself
        ConnectTimeout = TimeSpan.FromSeconds(10),
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    });
builder.Services.AddHostedService<Worker>();

// Same switch as the other backends: traces are exported only when an OTLP endpoint is given.
if (options.OtlpEndpoint is { } otlp)
{
    builder.Services.AddOpenTelemetry()
        .ConfigureResource(r => r.AddService(options.ServiceName))
        .WithTracing(t => t
            .AddAspNetCoreInstrumentation(o => o.Filter = ctx => ctx.Request.Path != "/metrics")
            .AddHttpClientInstrumentation()
            .AddNpgsql()
            .AddOtlpExporter(o =>
            {
                o.Endpoint = new Uri($"{otlp}/v1/traces");
                o.Protocol = OtlpExportProtocol.HttpProtobuf;
            }));
}

// X-API-Key requests go to the API key handler, everything else to JWT bearer.
builder.Services
    .AddAuthentication("smart")
    .AddPolicyScheme("smart", "JWT or API key", o => o.ForwardDefaultSelector = ctx =>
        ctx.Request.Headers.ContainsKey(ApiKeyHandler.Header) ? ApiKeyHandler.SchemeName : JwtBearerDefaults.AuthenticationScheme)
    .AddScheme<AuthenticationSchemeOptions, ApiKeyHandler>(ApiKeyHandler.SchemeName, null)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false; // keep "sub", "org" and "role" as-is
        o.TokenValidationParameters = TokenService.ValidationParameters(options);
        o.Events = new JwtBearerEvents
        {
            OnChallenge = ctx =>
            {
                ctx.HandleResponse();
                return Problems.Write(ctx.HttpContext, 401, "UNAUTHORIZED", "Missing, invalid or expired credentials");
            },
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();
app.Use(Problems.Middleware);
app.UseAuthentication();
app.UseAuthorization();

// Scraped by Prometheus straight from each replica; nginx does not proxy it.
app.MapMetrics("/metrics");

var api = app.MapGroup("/api");
api.MapGet("/health", async (NpgsqlDataSource db, IConnectionMultiplexer redis) =>
{
    try
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteScalarAsync<int>("SELECT 1");
        await redis.GetDatabase().PingAsync();
        return Results.Ok(new { status = "ok", backend = "dotnet" });
    }
    catch
    {
        return Results.Json(new { status = "degraded", backend = "dotnet" }, statusCode: 503);
    }
});
StatusEndpoints.Map(api);

// Everything below needs a JWT or an API key.
var authed = api.MapGroup("").RequireAuthorization();
AuthEndpoints.Map(api, authed);
OrgEndpoints.Map(authed);
MonitorEndpoints.Map(authed);
ActivityEndpoints.Map(authed);
api.MapFallback(() => { throw ApiException.NotFound("Route"); });

app.Run();

/// <summary>Writes timestamps as UTC ISO 8601 with millisecond precision, like the other backends.</summary>
internal sealed class UtcMillisConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTime().ToUniversalTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
        writer.WriteStringValue(Rules.Iso(value));
}
