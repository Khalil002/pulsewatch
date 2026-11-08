using System.Security.Claims;
using System.Text.Json.Serialization;
using Npgsql;

namespace Pulsewatch.Api;

public static class OrgEndpoints
{
    public sealed class OrgDto
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string Slug { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? WebhookSecret { get; set; }
    }

    public sealed class MemberDto
    {
        public Guid Id { get; set; }
        public string Email { get; set; } = "";
        public string Role { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    public sealed class ApiKeyDto
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string Prefix { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public DateTime? LastUsedAt { get; set; }
        public DateTime? RevokedAt { get; set; }
    }

    public sealed record NewMember(string? Email, string? Password, string? Role);
    public sealed record NewKey(string? Name);

    private const string MemberColumns = "id, email, role, created_at";
    private const string KeyColumns = "id, name, prefix, created_at, last_used_at, revoked_at";

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/org", async (ClaimsPrincipal p, Db db) =>
        {
            var caller = Caller.From(p);
            var org = await db.Plain(tx => tx.One<OrgDto>(
                "SELECT id, name, slug, created_at, webhook_secret FROM orgs WHERE id = @id", new { id = caller.OrgId }))
                ?? throw ApiException.NotFound("Organisation");
            if (!caller.Has("admin")) org.WebhookSecret = null;
            return Results.Ok(org);
        });

        // Members live in users, which has no row-level security (login looks users up across orgs),
        // so these queries filter on org_id explicitly.
        api.MapGet("/members", async (ClaimsPrincipal p, Db db) => Results.Ok(await db.Plain(tx => tx.Query<MemberDto>(
            $"SELECT {MemberColumns} FROM users WHERE org_id = @org ORDER BY created_at, id", new { org = Caller.From(p).OrgId }))));

        api.MapPost("/members", async (ClaimsPrincipal p, NewMember body, Db db) =>
        {
            var caller = Caller.From(p).Require("owner");
            var email = body.Email?.Trim().ToLowerInvariant() ?? "";
            var problems = new List<string>();
            if (!Rules.IsEmail(email)) problems.Add("email: must be an email address");
            if (body.Password is not { Length: >= 8 and <= 72 }) problems.Add("password: must be 8-72 characters");
            if (body.Role is not ("admin" or "viewer")) problems.Add("role: must be admin or viewer");
            if (problems.Count > 0) throw ApiException.Validation(string.Join("; ", problems));
            try
            {
                var member = await db.Plain(tx => tx.One<MemberDto>(
                    $"INSERT INTO users (org_id, email, password_hash, role) VALUES (@org, @email, @hash, @role) RETURNING {MemberColumns}",
                    new { org = caller.OrgId, email, hash = BCrypt.Net.BCrypt.HashPassword(body.Password, 10), role = body.Role }));
                return Results.Json(member, statusCode: 201);
            }
            catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                throw new ApiException(409, "EMAIL_TAKEN", "Email is already registered");
            }
        });

        api.MapGet("/api-keys", async (ClaimsPrincipal p, Db db) =>
        {
            var caller = Caller.From(p).RequireUser().Require("admin");
            return Results.Ok(await db.InOrg(caller.OrgId, tx => tx.Query<ApiKeyDto>(
                $"SELECT {KeyColumns} FROM api_keys ORDER BY created_at DESC, id")));
        });

        api.MapPost("/api-keys", async (ClaimsPrincipal p, NewKey body, Db db) =>
        {
            var caller = Caller.From(p).RequireUser().Require("admin");
            var name = body.Name?.Trim() ?? "";
            if (name.Length is < 1 or > 60) throw ApiException.Validation("name: must be 1-60 characters");
            var key = Rules.NewApiKey();
            var row = (await db.InOrg(caller.OrgId, tx => tx.One<ApiKeyDto>(
                $"INSERT INTO api_keys (org_id, name, prefix, key_hash, created_by) VALUES (@org, @name, @prefix, @hash, @user) RETURNING {KeyColumns}",
                new { org = caller.OrgId, name, prefix = key.Prefix, hash = key.Hash, user = caller.UserId })))!;
            return Results.Json(new { row.Id, row.Name, row.Prefix, row.CreatedAt, row.LastUsedAt, row.RevokedAt, key = key.Key },
                statusCode: 201);
        });

        api.MapDelete("/api-keys/{id}", async (ClaimsPrincipal p, string id, Db db) =>
        {
            var caller = Caller.From(p).RequireUser().Require("admin");
            var keyId = Ids.Parse(id, "API key");
            var updated = await db.InOrg(caller.OrgId, tx => tx.Execute(
                "UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = @keyId", new { keyId }));
            return updated == 0 ? throw ApiException.NotFound("API key") : Results.NoContent();
        });
    }
}

public static class Ids
{
    /// <summary>A path id that is not a UUID can't name anything, so it is a 404 rather than a 400.</summary>
    public static Guid Parse(string value, string what) =>
        value.Length == 36 && Guid.TryParseExact(value, "D", out var id) ? id : throw ApiException.NotFound(what);

    public static Guid? Filter(string? value, string field) =>
        value is null ? null
        : value.Length == 36 && Guid.TryParseExact(value, "D", out var id) ? id
        : throw ApiException.Validation($"{field}: must be a UUID");
}
