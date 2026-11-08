package dev.pulsewatch.auth;

import dev.pulsewatch.web.ApiException;
import dev.pulsewatch.web.ErrorCode;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/** Who is calling: a signed-in user, or an API key (which acts as an admin of its org). */
public record Caller(UUID userId, UUID keyId, UUID orgId, Role role, String email) {

    public static Caller current() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken jwt) {
            var t = jwt.getToken();
            return new Caller(UUID.fromString(t.getSubject()), null, UUID.fromString(t.getClaimAsString("org")),
                    Role.parse(t.getClaimAsString("role")), t.getClaimAsString("email"));
        }
        if (auth instanceof ApiKeyAuthentication key) {
            return new Caller(null, key.keyId(), key.orgId(), Role.ADMIN, null);
        }
        throw new ApiException(401, ErrorCode.UNAUTHORIZED, "Missing, invalid or expired credentials");
    }

    public boolean isUser() {
        return userId != null;
    }

    public boolean has(Role min) {
        return role.atLeast(min);
    }

    public Caller require(Role min) {
        if (!has(min)) throw ApiException.forbidden("requires the " + min.value() + " role");
        return this;
    }

    public Caller requireUser() {
        if (!isUser()) throw ApiException.forbidden("API keys cannot do this; sign in instead");
        return this;
    }
}
