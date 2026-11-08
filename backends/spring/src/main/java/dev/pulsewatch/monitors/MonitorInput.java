package dev.pulsewatch.monitors;

import com.fasterxml.jackson.databind.JsonNode;
import dev.pulsewatch.web.ApiException;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Validates a monitor body read as raw JSON, so PATCH can tell a missing field from an explicit
 * null, and so numbers are not silently coerced from strings. Returns column -> value.
 */
final class MonitorInput {
    private MonitorInput() {}

    static Map<String, Object> parse(JsonNode body, boolean partial) {
        if (body == null || !body.isObject()) throw ApiException.invalid("body: must be a JSON object");
        Map<String, Object> out = new LinkedHashMap<>();
        List<String> errors = new ArrayList<>();

        text(body, "name", 1, 100, partial, errors).ifPresent(v -> out.put("name", v));
        url(body, "url", false, partial, errors, out, "url");
        if (body.has("method")) {
            String m = body.get("method").isTextual() ? body.get("method").asText() : "";
            if (m.equals("GET") || m.equals("HEAD")) out.put("method", m);
            else errors.add("method: must be GET or HEAD");
        } else if (!partial) out.put("method", "GET");
        integer(body, "intervalSec", 10, 3600, 60, partial, errors, out, "interval_sec");
        integer(body, "timeoutMs", 500, 10000, 5000, partial, errors, out, "timeout_ms");
        integer(body, "expectedStatus", 100, 599, 200, partial, errors, out, "expected_status");
        url(body, "alertWebhookUrl", true, partial, errors, out, "alert_webhook_url");
        if (body.has("paused")) {
            if (body.get("paused").isBoolean()) out.put("paused", body.get("paused").asBoolean());
            else errors.add("paused: must be a boolean");
        } else if (!partial) out.put("paused", false);

        if (!errors.isEmpty()) throw ApiException.invalid(String.join("; ", errors));
        if (partial && out.isEmpty()) throw ApiException.invalid("body: at least one field is required");
        return out;
    }

    private static java.util.Optional<String> text(JsonNode body, String field, int min, int max, boolean partial,
            List<String> errors) {
        if (!body.has(field)) {
            if (!partial) errors.add(field + ": is required");
            return java.util.Optional.empty();
        }
        JsonNode node = body.get(field);
        String value = node.isTextual() ? node.asText().trim() : null;
        if (value == null || value.length() < min || value.length() > max) {
            errors.add(field + ": must be " + min + " to " + max + " characters");
            return java.util.Optional.empty();
        }
        return java.util.Optional.of(value);
    }

    private static void url(JsonNode body, String field, boolean nullable, boolean partial, List<String> errors,
            Map<String, Object> out, String column) {
        if (!body.has(field)) {
            if (!partial && !nullable) errors.add(field + ": is required");
            else if (!partial) out.put(column, null);
            return;
        }
        JsonNode node = body.get(field);
        if (node.isNull() && nullable) {
            out.put(column, null);
            return;
        }
        if (node.isTextual() && isHttpUrl(node.asText())) out.put(column, node.asText());
        else errors.add(field + ": must be an http:// or https:// URL");
    }

    static boolean isHttpUrl(String value) {
        if (value.length() > 2048 || !value.matches("(?i)^https?://.*")) return false;
        try {
            URI uri = new URI(value);
            return uri.getHost() != null && !uri.getHost().isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private static void integer(JsonNode body, String field, int min, int max, int fallback, boolean partial,
            List<String> errors, Map<String, Object> out, String column) {
        if (!body.has(field)) {
            if (!partial) out.put(column, fallback);
            return;
        }
        JsonNode node = body.get(field);
        if (!node.isNumber() || !node.canConvertToExactIntegral() || node.asLong() < min || node.asLong() > max) {
            errors.add(field + ": must be an integer from " + min + " to " + max);
            return;
        }
        out.put(column, node.asInt());
    }
}
