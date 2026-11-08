package dev.pulsewatch.web;

import java.util.UUID;
import java.util.regex.Pattern;

public final class Ids {
    private static final Pattern UUID_PATTERN =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    private Ids() {}

    public static boolean isUuid(String value) {
        return value != null && UUID_PATTERN.matcher(value).matches();
    }

    /** A path id that is not a UUID can't name anything, so it is a 404 rather than a 400. */
    public static UUID parse(String value, String what) {
        if (!isUuid(value)) throw ApiException.notFound(what);
        return UUID.fromString(value);
    }
}
