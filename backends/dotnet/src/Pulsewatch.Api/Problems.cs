using System.Text.Json;

namespace Pulsewatch.Api;

/// <summary>Thrown anywhere in the request path; rendered as an RFC 7807 problem.</summary>
public sealed class ApiException(int status, string code, string title, string? detail = null,
    IReadOnlyDictionary<string, string>? headers = null) : Exception(title)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public string? Detail { get; } = detail;
    public IReadOnlyDictionary<string, string> Headers { get; } = headers ?? new Dictionary<string, string>();

    public static ApiException NotFound(string what) => new(404, "NOT_FOUND", $"{what} not found");
    public static ApiException Validation(string detail) => new(400, "VALIDATION_ERROR", "Request validation failed", detail);
    public static ApiException Forbidden(string detail) => new(403, "FORBIDDEN", "Not allowed", detail);
}

public static class Problems
{
    public static Task Write(HttpContext ctx, int status, string code, string title, string? detail = null)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/problem+json";
        var body = new Dictionary<string, object> { ["type"] = "about:blank", ["title"] = title, ["status"] = status, ["code"] = code };
        if (detail is not null) body["detail"] = detail;
        return ctx.Response.WriteAsync(JsonSerializer.Serialize(body));
    }

    /// <summary>Turns ApiException and bad request bodies into problem responses.</summary>
    public static async Task Middleware(HttpContext ctx, RequestDelegate next)
    {
        try
        {
            await next(ctx);
        }
        catch (ApiException e)
        {
            foreach (var (k, v) in e.Headers) ctx.Response.Headers[k] = v;
            await Write(ctx, e.Status, e.Code, e.Message, e.Detail);
        }
        catch (BadHttpRequestException)
        {
            await Write(ctx, 400, "VALIDATION_ERROR", "Malformed request body");
        }
        catch (Exception e)
        {
            ctx.RequestServices.GetRequiredService<ILogger<ApiException>>().LogError(e, "unhandled error");
            if (!ctx.Response.HasStarted) await Write(ctx, 500, "INTERNAL", "Internal server error");
        }
    }
}
