package dev.pulsewatch.auth;

import dev.pulsewatch.config.Tenancy;
import dev.pulsewatch.web.ApiException;
import dev.pulsewatch.web.ErrorCode;
import dev.pulsewatch.worker.Rules;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuthController {
    static final String USER_COLUMNS = "id, email, role, org_id";

    public record Registration(
            @NotNull @Email @Size(max = 254) String email,
            @NotNull @Size(min = 8, max = 72) String password,
            @NotNull String orgName) {}

    public record Login(String email, String password) {}

    public record AuthResponse(String token, UserDto user) {}

    private record UserRow(UUID id, String email, String role, UUID orgId, String passwordHash) {
        UserDto dto() { return new UserDto(id, email, role, orgId); }
    }

    private final JdbcClient db;
    private final Tenancy tenancy;
    private final TokenService tokens;
    private final BCryptPasswordEncoder passwords;

    public AuthController(JdbcClient db, Tenancy tenancy, TokenService tokens, BCryptPasswordEncoder passwords) {
        this.db = db;
        this.tenancy = tenancy;
        this.tokens = tokens;
        this.passwords = passwords;
    }

    @PostMapping("/api/auth/register")
    @ResponseStatus(HttpStatus.CREATED)
    public AuthResponse register(@Valid @RequestBody Registration body) {
        String email = body.email().trim().toLowerCase(Locale.ROOT);
        String orgName = body.orgName().trim();
        if (orgName.length() < 2 || orgName.length() > 60) throw ApiException.invalid("orgName: must be 2 to 60 characters");
        String hash = passwords.encode(body.password());
        try {
            UserDto user = tenancy.plain(() -> {
                if (db.sql("SELECT 1 FROM users WHERE lower(email) = ?").param(email).query(Integer.class).optional().isPresent()) {
                    throw emailTaken();
                }
                // The random suffix makes a slug clash unlikely; retry a few times if one happens.
                Optional<UUID> orgId = Optional.empty();
                for (int attempt = 0; orgId.isEmpty(); attempt++) {
                    if (attempt == 5) throw new IllegalStateException("could not allocate an org slug");
                    orgId = db.sql("INSERT INTO orgs (name, slug) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING RETURNING id")
                            .params(orgName, Rules.orgSlug(orgName)).query(UUID.class).optional();
                }
                return db.sql("INSERT INTO users (org_id, email, password_hash, role) VALUES (?, ?, ?, 'owner') RETURNING "
                                + USER_COLUMNS)
                        .params(orgId.get(), email, hash).query(UserDto.class).single();
            });
            return new AuthResponse(tokens.issue(user), user);
        } catch (DuplicateKeyException e) {
            throw emailTaken();
        }
    }

    @PostMapping("/api/auth/login")
    public AuthResponse login(@RequestBody(required = false) Login body) {
        String email = body == null || body.email() == null ? "" : body.email().trim().toLowerCase(Locale.ROOT);
        String password = body == null || body.password() == null ? "" : body.password();
        Optional<UserRow> found = db.sql("SELECT " + USER_COLUMNS + ", password_hash FROM users WHERE lower(email) = ?")
                .param(email).query(UserRow.class).optional();
        if (found.isEmpty() || !passwords.matches(password, found.get().passwordHash())) {
            throw new ApiException(401, ErrorCode.INVALID_CREDENTIALS, "Email or password is incorrect");
        }
        UserDto user = found.get().dto();
        return new AuthResponse(tokens.issue(user), user);
    }

    @GetMapping("/api/me")
    public UserDto me() {
        Caller caller = Caller.current();
        if (!caller.isUser()) throw ApiException.forbidden("API keys have no user");
        return db.sql("SELECT " + USER_COLUMNS + " FROM users WHERE id = ?").param(caller.userId())
                .query(UserDto.class).optional().orElseThrow(() -> ApiException.notFound("User"));
    }

    static ApiException emailTaken() {
        return new ApiException(409, ErrorCode.EMAIL_TAKEN, "Email is already registered", null, Map.of());
    }
}
