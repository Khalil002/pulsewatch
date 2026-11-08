package dev.pulsewatch.auth;

import java.util.UUID;

public record UserDto(UUID id, String email, String role, UUID orgId) {}
