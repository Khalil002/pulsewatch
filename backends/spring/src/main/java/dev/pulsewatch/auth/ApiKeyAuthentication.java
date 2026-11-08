package dev.pulsewatch.auth;

import java.util.List;
import java.util.UUID;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

public class ApiKeyAuthentication extends AbstractAuthenticationToken {
    private final UUID keyId;
    private final UUID orgId;

    public ApiKeyAuthentication(UUID keyId, UUID orgId) {
        super(List.of(new SimpleGrantedAuthority("ROLE_ADMIN")));
        this.keyId = keyId;
        this.orgId = orgId;
        setAuthenticated(true);
    }

    public UUID keyId() { return keyId; }
    public UUID orgId() { return orgId; }

    @Override public Object getCredentials() { return ""; }
    @Override public Object getPrincipal() { return keyId; }
}
