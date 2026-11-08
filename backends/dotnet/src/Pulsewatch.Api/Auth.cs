using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using StackExchange.Redis;

namespace Pulsewatch.Api;

public sealed class UserDto
{
    public Guid Id { get; set; }
    public string Email { get; set; } = "";
    public string Role { get; set; } = "";
    public Guid OrgId { get; set; }
}

public static class Roles
{
    private static int Rank(string role) => role switch { "owner" => 2, "admin" => 1, _ => 0 };
    public static bool AtLeast(string role, string min) => Rank(role) >= Rank(min);
}

/// <summary>Who is calling: a signed-in user, or an API key (which acts as an admin of its org).</summary>
public sealed record Caller(Guid? UserId, Guid? KeyId, Guid OrgId, string Role)
{
    public static Caller From(ClaimsPrincipal p)
    {
        var org = Guid.Parse(p.FindFirstValue("org")!);
        if (p.FindFirstValue("key_id") is { } key) return new Caller(null, Guid.Parse(key), org, "admin");
        return new Caller(Guid.Parse(p.FindFirstValue("sub")!), null, org, p.FindFirstValue("role") ?? "viewer");
    }

    public bool IsUser => UserId is not null;
    public bool Has(string min) => Roles.AtLeast(Role, min);

    public Caller Require(string min) => Has(min) ? this : throw ApiException.Forbidden($"requires the {min} role");

    public Caller RequireUser() => IsUser ? this : throw ApiException.Forbidden("API keys cannot do this; sign in instead");
}

/// <summary>Issues the HS256 token every backend accepts (claims: sub, email, role, org, iss=pulsewatch).</summary>
public sealed class TokenService(AppOptions options)
{
    public const string Issuer = "pulsewatch";

    public static SymmetricSecurityKey SigningKey(AppOptions options) => new(Encoding.UTF8.GetBytes(options.JwtSecret));

    public static TokenValidationParameters ValidationParameters(AppOptions options) => new()
    {
        ValidIssuer = Issuer,
        ValidateAudience = false,
        IssuerSigningKey = SigningKey(options),
        ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
        RoleClaimType = "role",
        ClockSkew = TimeSpan.FromSeconds(5),
    };

    public string Issue(UserDto user)
    {
        var now = DateTime.UtcNow;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            IssuedAt = now,
            NotBefore = now,
            Expires = now.AddSeconds(options.JwtTtlSec),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = user.Id.ToString(), ["email"] = user.Email, ["role"] = user.Role, ["org"] = user.OrgId.ToString(),
            },
            SigningCredentials = new SigningCredentials(SigningKey(options), SecurityAlgorithms.HmacSha256),
        });
    }
}

/// <summary>Authenticates X-API-Key requests and applies the per-key rate limit (shared across replicas via Redis).</summary>
public sealed class ApiKeyHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> schemeOptions, ILoggerFactory logger, UrlEncoder encoder,
    NpgsqlDataSource db, IConnectionMultiplexer redis, AppOptions options)
    : AuthenticationHandler<AuthenticationSchemeOptions>(schemeOptions, logger, encoder)
{
    public const string SchemeName = "ApiKey";
    public const string Header = "X-API-Key";

    private sealed class KeyRow
    {
        public Guid KeyId { get; set; }
        public Guid KeyOrgId { get; set; }
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(Header, out var values) || values.ToString() is not { Length: > 0 } raw)
            return AuthenticateResult.NoResult();
        // api_key_lookup is SECURITY DEFINER: the org isn't known yet, so it can't go through row-level security.
        await using var conn = await db.OpenConnectionAsync();
        var key = await Dapper.SqlMapper.QuerySingleOrDefaultAsync<KeyRow>(conn,
            "SELECT key_id, key_org_id FROM api_key_lookup(@hash)", new { hash = Rules.Sha256Hex(raw) });
        if (key is null) return AuthenticateResult.Fail("Invalid or revoked API key");

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var window = now / options.RateLimitWindowSec;
        var counter = Keys.RateLimit(key.KeyId, window);
        var cache = redis.GetDatabase();
        var count = await cache.StringIncrementAsync(counter);
        if (count == 1) await cache.KeyExpireAsync(counter, TimeSpan.FromSeconds(options.RateLimitWindowSec));
        if (count > options.RateLimitMax)
        {
            var retryAfter = Math.Max(1, (window + 1) * options.RateLimitWindowSec - now);
            throw new ApiException(429, "RATE_LIMITED", "Too many requests for this API key",
                $"limit is {options.RateLimitMax} per {options.RateLimitWindowSec}s",
                new Dictionary<string, string> { ["Retry-After"] = retryAfter.ToString() });
        }
        var identity = new ClaimsIdentity(
            [new Claim("key_id", key.KeyId.ToString()), new Claim("org", key.KeyOrgId.ToString()), new Claim("role", "admin")],
            SchemeName, null, "role");
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        Problems.Write(Context, 401, "UNAUTHORIZED", "Invalid or revoked API key");
}

public static class AuthEndpoints
{
    private const string UserColumns = "id, email, role, org_id";

    public sealed record Registration(string? Email, string? Password, string? OrgName);
    public sealed record Login(string? Email, string? Password);

    private sealed class UserRow
    {
        public Guid Id { get; set; }
        public string Email { get; set; } = "";
        public string Role { get; set; } = "";
        public Guid OrgId { get; set; }
        public string PasswordHash { get; set; } = "";
        public UserDto ToDto() => new() { Id = Id, Email = Email, Role = Role, OrgId = OrgId };
    }

    public static void Map(RouteGroupBuilder api, RouteGroupBuilder authed)
    {
        api.MapPost("/auth/register", Register);
        api.MapPost("/auth/login", LoginUser);
        authed.MapGet("/me", Me);
    }

    private static ApiException EmailTaken() => new(409, "EMAIL_TAKEN", "Email is already registered");

    private static async Task<IResult> Register(Registration body, Db db, TokenService tokens)
    {
        var email = body.Email?.Trim().ToLowerInvariant() ?? "";
        var orgName = body.OrgName?.Trim() ?? "";
        var problems = new List<string>();
        if (!Rules.IsEmail(email)) problems.Add("email: must be an email address");
        if (body.Password is not { Length: >= 8 and <= 72 }) problems.Add("password: must be 8-72 characters");
        if (orgName.Length is < 2 or > 60) problems.Add("orgName: must be 2-60 characters");
        if (problems.Count > 0) throw ApiException.Validation(string.Join("; ", problems));

        var hash = BCrypt.Net.BCrypt.HashPassword(body.Password, 10);
        try
        {
            var user = await db.Plain(async tx =>
            {
                if (await tx.One<int?>("SELECT 1 FROM users WHERE lower(email) = @email", new { email }) is not null) throw EmailTaken();
                // The random suffix makes a slug clash unlikely; retry a few times if one happens.
                Guid? orgId = null;
                for (var attempt = 0; orgId is null; attempt++)
                {
                    if (attempt == 5) throw new InvalidOperationException("could not allocate an org slug");
                    orgId = await tx.One<Guid?>(
                        "INSERT INTO orgs (name, slug) VALUES (@orgName, @slug) ON CONFLICT (slug) DO NOTHING RETURNING id",
                        new { orgName, slug = Rules.OrgSlug(orgName) });
                }
                return (await tx.One<UserDto>(
                    $"INSERT INTO users (org_id, email, password_hash, role) VALUES (@orgId, @email, @hash, 'owner') RETURNING {UserColumns}",
                    new { orgId, email, hash }))!;
            });
            return Results.Json(new { token = tokens.Issue(user), user }, statusCode: 201);
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw EmailTaken();
        }
    }

    private static async Task<IResult> LoginUser(Login body, Db db, TokenService tokens)
    {
        var email = body.Email?.Trim().ToLowerInvariant() ?? "";
        var row = await db.Plain(tx => tx.One<UserRow>($"SELECT {UserColumns}, password_hash FROM users WHERE lower(email) = @email", new { email }));
        if (row is null || !BCrypt.Net.BCrypt.Verify(body.Password ?? "", row.PasswordHash))
            throw new ApiException(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
        var user = row.ToDto();
        return Results.Ok(new { token = tokens.Issue(user), user });
    }

    private static async Task<IResult> Me(ClaimsPrincipal principal, Db db)
    {
        var caller = Caller.From(principal);
        if (!caller.IsUser) throw ApiException.Forbidden("API keys have no user");
        var me = await db.Plain(tx => tx.One<UserDto>($"SELECT {UserColumns} FROM users WHERE id = @id", new { id = caller.UserId }));
        return me is null ? throw ApiException.NotFound("User") : Results.Ok(me);
    }
}
