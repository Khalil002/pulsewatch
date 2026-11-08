package dev.pulsewatch.web;

import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<Object> api(ApiException e) {
        return Problems.entity(e);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<Object> invalid(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + ": " + f.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return Problems.entity(new ApiException(400, ErrorCode.VALIDATION_ERROR, "Request validation failed",
                detail, java.util.Map.of()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<Object> unreadable(HttpMessageNotReadableException e) {
        return Problems.entity(new ApiException(400, ErrorCode.VALIDATION_ERROR, "Malformed request body"));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    ResponseEntity<Object> badParam(MethodArgumentTypeMismatchException e) {
        return Problems.entity(ApiException.invalid(e.getName() + ": has the wrong type"));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<Object> badMethod(HttpRequestMethodNotSupportedException e) {
        return Problems.entity(ApiException.notFound("Route"));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<Object> noRoute(NoResourceFoundException e) {
        return Problems.entity(ApiException.notFound("Route"));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<Object> unexpected(Exception e) {
        log.error("unhandled error", e);
        return Problems.entity(new ApiException(500, ErrorCode.INTERNAL, "Internal server error"));
    }
}
