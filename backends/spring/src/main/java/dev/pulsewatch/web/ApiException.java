package dev.pulsewatch.web;

import java.util.Map;

/** Thrown anywhere in the request path; rendered as an RFC 7807 problem. */
public class ApiException extends RuntimeException {
    private final int status;
    private final ErrorCode code;
    private final String detail;
    private final Map<String, String> headers;

    public ApiException(int status, ErrorCode code, String title) {
        this(status, code, title, null, Map.of());
    }

    public ApiException(int status, ErrorCode code, String title, String detail, Map<String, String> headers) {
        super(title);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.headers = headers;
    }

    public static ApiException notFound(String what) {
        return new ApiException(404, ErrorCode.NOT_FOUND, what + " not found");
    }

    public static ApiException forbidden(String detail) {
        return new ApiException(403, ErrorCode.FORBIDDEN, "Not allowed", detail, Map.of());
    }

    public static ApiException invalid(String detail) {
        return new ApiException(400, ErrorCode.VALIDATION_ERROR, "Request validation failed", detail, Map.of());
    }

    public int status() { return status; }
    public ErrorCode code() { return code; }
    public String detail() { return detail; }
    public Map<String, String> headers() { return headers; }
}
