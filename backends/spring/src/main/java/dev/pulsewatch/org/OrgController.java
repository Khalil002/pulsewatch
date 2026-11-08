package dev.pulsewatch.org;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.pulsewatch.auth.Caller;
import dev.pulsewatch.auth.Role;
import dev.pulsewatch.config.Tenancy;
import dev.pulsewatch.web.ApiException;
import dev.pulsewatch.web.ErrorCode;
import dev.pulsewatch.web.Ids;
import dev.pulsewatch.worker.Rules;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrgController {
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Org(UUID id, String name, String slug, OffsetDateTime createdAt, String webhookSecret) {}

    public record Member(UUID id, String email, String role, OffsetDateTime createdAt) {}

    public record NewMember(
            @NotNull @Email @Size(max = 254) String email,
            @NotNull @Size(min = 8, max = 72) String password,
            @NotNull @Pattern(regexp = "admin|viewer", message = "must be admin or viewer") String role) {}

    public record ApiKey(UUID id, String name, String prefix, OffsetDateTime createdAt, OffsetDateTime lastUsedAt,
            OffsetDateTime revokedAt) {}

    public record CreatedKey(UUID id, String name, String prefix, OffsetDateTime createdAt, OffsetDateTime lastUsedAt,
            OffsetDateTime revokedAt, String key) {}

    public record NewKey(String name) {}

    private static final String MEMBER_COLUMNS = "id, email, role, created_at";
    private static final String KEY_COLUMNS = "id, name, prefix, created_at, last_used_at, revoked_at";

    private final JdbcClient db;
    private final Tenancy tenancy;
    private final BCryptPasswordEncoder passwords;

    public OrgController(JdbcClient db, Tenancy tenancy, BCryptPasswordEncoder passwords) {
        this.db = db;
        this.tenancy = tenancy;
        this.passwords = passwords;
    }

    @GetMapping("/api/org")
    public Org org() {
        Caller caller = Caller.current();
        Org org = db.sql("SELECT id, name, slug, created_at, webhook_secret FROM orgs WHERE id = ?")
                .param(caller.orgId()).query(Org.class).optional()
                .orElseThrow(() -> ApiException.notFound("Organisation"));
        return caller.has(Role.ADMIN) ? org : new Org(org.id(), org.name(), org.slug(), org.createdAt(), null);
    }

    // Members live in users, which has no row-level security (login looks users up across orgs),
    // so these queries filter on org_id explicitly.
    @GetMapping("/api/members")
    public List<Member> members() {
        return db.sql("SELECT " + MEMBER_COLUMNS + " FROM users WHERE org_id = ? ORDER BY created_at, id")
                .param(Caller.current().orgId()).query(Member.class).list();
    }

    @PostMapping("/api/members")
    @ResponseStatus(HttpStatus.CREATED)
    public Member addMember(@Valid @RequestBody NewMember body) {
        Caller caller = Caller.current().require(Role.OWNER);
        try {
            return db.sql("INSERT INTO users (org_id, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING " + MEMBER_COLUMNS)
                    .params(caller.orgId(), body.email().trim().toLowerCase(Locale.ROOT), passwords.encode(body.password()), body.role())
                    .query(Member.class).single();
        } catch (DuplicateKeyException e) {
            throw new ApiException(409, ErrorCode.EMAIL_TAKEN, "Email is already registered", null, Map.of());
        }
    }

    @GetMapping("/api/api-keys")
    public List<ApiKey> keys() {
        Caller caller = Caller.current().requireUser().require(Role.ADMIN);
        return tenancy.inOrg(caller.orgId(), () ->
                db.sql("SELECT " + KEY_COLUMNS + " FROM api_keys ORDER BY created_at DESC, id").query(ApiKey.class).list());
    }

    @PostMapping("/api/api-keys")
    @ResponseStatus(HttpStatus.CREATED)
    public CreatedKey createKey(@RequestBody(required = false) NewKey body) {
        Caller caller = Caller.current().requireUser().require(Role.ADMIN);
        String name = body == null || body.name() == null ? "" : body.name().trim();
        if (name.isEmpty() || name.length() > 60) throw ApiException.invalid("name: must be 1 to 60 characters");
        Rules.NewKey key = Rules.newApiKey();
        ApiKey row = tenancy.inOrg(caller.orgId(), () -> db.sql(
                        "INSERT INTO api_keys (org_id, name, prefix, key_hash, created_by) VALUES (?, ?, ?, ?, ?) RETURNING " + KEY_COLUMNS)
                .params(caller.orgId(), name, key.prefix(), key.hash(), caller.userId())
                .query(ApiKey.class).single());
        return new CreatedKey(row.id(), row.name(), row.prefix(), row.createdAt(), row.lastUsedAt(), row.revokedAt(), key.key());
    }

    @DeleteMapping("/api/api-keys/{id}")
    public ResponseEntity<Void> revoke(@PathVariable String id) {
        Caller caller = Caller.current().requireUser().require(Role.ADMIN);
        UUID keyId = Ids.parse(id, "API key");
        int updated = tenancy.inOrg(caller.orgId(), () ->
                db.sql("UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = ?").param(keyId).update());
        if (updated == 0) throw ApiException.notFound("API key");
        return ResponseEntity.noContent().build();
    }
}
