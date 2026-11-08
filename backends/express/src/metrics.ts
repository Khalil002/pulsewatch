import client from "prom-client";

// Same metric names in every backend, so one Grafana dashboard fits all of them.
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const checksTotal = new client.Counter({
  name: "pulsewatch_checks_total", help: "Checks run, by result", labelNames: ["result"], registers: [registry],
});
export const checkDuration = new client.Histogram({
  name: "pulsewatch_check_duration_seconds", help: "Time to the target's response headers",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry],
});
export const alertsTotal = new client.Counter({
  name: "pulsewatch_alerts_total", help: "Alert delivery attempts, by outcome", labelNames: ["outcome"], registers: [registry],
});
