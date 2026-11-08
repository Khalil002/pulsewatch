const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const str = (name: string, fallback: string): string => process.env[name] || fallback;

export const config = {
  port: num("PORT", 8000),
  db: {
    host: str("DB_HOST", "localhost"),
    port: num("DB_PORT", 5432),
    database: str("DB_NAME", "pulsewatch"),
    user: str("DB_USER", "pulsewatch_app"),
    password: str("DB_PASSWORD", "pulsewatch_app"),
  },
  redis: { host: str("REDIS_HOST", "localhost"), port: num("REDIS_PORT", 6379) },
  jwtSecret: str("JWT_SECRET", "change-me-to-a-long-random-secret-of-32-bytes"),
  jwtTtlSec: num("JWT_TTL_SEC", 43200),
  rateLimitMax: num("RATE_LIMIT_MAX", 60),
  rateLimitWindowSec: num("RATE_LIMIT_WINDOW_SEC", 60),
  cacheTtlSec: num("CACHE_TTL_SEC", 5),
  retentionDays: num("RETENTION_DAYS", 30),
  schedulerTickMs: num("SCHEDULER_TICK_MS", 1000),
  maxInFlightChecks: num("MAX_INFLIGHT_CHECKS", 50),
};
