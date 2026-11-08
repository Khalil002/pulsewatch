package dev.pulsewatch;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class PulsewatchApplication {
    public static void main(String[] args) {
        // Same switch as the other backends: traces are exported only when an OTLP endpoint is given.
        String otlp = System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT");
        if (otlp != null && !otlp.isBlank()) {
            System.setProperty("management.otlp.tracing.endpoint", otlp.replaceAll("/$", "") + "/v1/traces");
        } else {
            System.setProperty("management.tracing.enabled", "false");
        }
        SpringApplication.run(PulsewatchApplication.class, args);
    }
}
