package dev.pulsewatch.auth;

import com.fasterxml.jackson.annotation.JsonValue;

public enum Role {
    VIEWER, ADMIN, OWNER;

    public static Role parse(String value) {
        return Role.valueOf(value.toUpperCase());
    }

    @JsonValue
    public String value() {
        return name().toLowerCase();
    }

    public boolean atLeast(Role min) {
        return ordinal() >= min.ordinal();
    }
}
