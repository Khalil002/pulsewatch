package dev.pulsewatch.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

public final class Problems {
    private Problems() {}

    public static Map<String, Object> body(int status, ErrorCode code, String title, String detail) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "about:blank");
        body.put("title", title);
        body.put("status", status);
        body.put("code", code.name());
        if (detail != null) body.put("detail", detail);
        return body;
    }

    public static ResponseEntity<Object> entity(ApiException e) {
        HttpHeaders headers = new HttpHeaders();
        e.headers().forEach(headers::add);
        return ResponseEntity.status(e.status()).headers(headers)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(body(e.status(), e.code(), e.getMessage(), e.detail()));
    }

    /** For filters (security) that run before Spring MVC. */
    public static void write(HttpServletResponse res, ObjectMapper mapper, int status, ErrorCode code, String title,
            String detail) throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        mapper.writeValue(res.getOutputStream(), body(status, code, title, detail));
    }
}
