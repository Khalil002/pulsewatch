// Preloaded with `node --require ./dist/tracing.js`, before any instrumented module is imported.
// Tracing is on only when OTEL_EXPORTER_OTLP_ENDPOINT is set (for example http://jaeger:4318).
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint) {
  process.env.OTEL_SERVICE_NAME ||= "pulsewatch-express";
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === "/metrics" }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  process.on("SIGTERM", () => void sdk.shutdown());
}
