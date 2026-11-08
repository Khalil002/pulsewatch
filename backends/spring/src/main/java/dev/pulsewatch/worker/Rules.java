package dev.pulsewatch.worker;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Rules every backend implements identically. The unit tests in each backend pin the same values. */
public final class Rules {
    private Rules() {}

    public static final int MAX_ALERT_ATTEMPTS = 5;
    private static final String SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
    private static final SecureRandom RANDOM = new SecureRandom();

    /** Seconds to wait before retrying a delivery that has failed {@code attempts} times. */
    public static long backoffSeconds(int attempts) {
        return 1L << attempts;
    }

    /** "Acme Corp!" -> "acme-corp". Non-ASCII letters are dropped; an empty result becomes "org". */
    public static String slugify(String name) {
        String base = name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        if (base.length() > 40) base = base.substring(0, 40);
        base = base.replaceAll("-+$", "");
        return base.isEmpty() ? "org" : base;
    }

    /** Public slug: slugified name plus 4 random characters, so names don't have to be unique. */
    public static String orgSlug(String name) {
        StringBuilder sb = new StringBuilder(slugify(name)).append('-');
        for (int i = 0; i < 4; i++) sb.append(SLUG_CHARS.charAt(RANDOM.nextInt(SLUG_CHARS.length())));
        return sb.toString();
    }

    public static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public record NewKey(String key, String prefix, String hash) {}

    /** API keys look like pw_ + 48 hex chars. Only the SHA-256 is stored. */
    public static NewKey newApiKey() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        String key = "pw_" + HexFormat.of().formatHex(bytes);
        return new NewKey(key, key.substring(0, 10), sha256Hex(key));
    }

    /** Value of the X-Pulsewatch-Signature header for a raw webhook body. */
    public static String signature(String secret, String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return "sha256=" + HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public record Outcome(boolean ok, Integer statusCode, int latencyMs, String error) {}

    public static Outcome response(int statusCode, int expected, int latencyMs) {
        boolean ok = statusCode == expected;
        return new Outcome(ok, statusCode, latencyMs, ok ? null : "expected " + expected + " but got " + statusCode);
    }

    public static Outcome timeout(int timeoutMs, int latencyMs) {
        return new Outcome(false, null, latencyMs, "timeout after " + timeoutMs + " ms");
    }

    public static Outcome connectionFailed(String reason, int latencyMs) {
        return new Outcome(false, null, latencyMs, "connection failed: " + reason);
    }

    public record Transition(String status, boolean opens, boolean resolves) {}

    /** What a check result does to a monitor: its new status, and whether an incident opens or resolves. */
    public static Transition transition(String previous, boolean ok) {
        if (ok) return new Transition("up", false, "down".equals(previous));
        return new Transition("down", !"down".equals(previous), false);
    }
}
