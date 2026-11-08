import { Redis } from "ioredis";
import { config } from "./config";

export const redis = new Redis({ host: config.redis.host, port: config.redis.port, maxRetriesPerRequest: 3 });

/** Redis key names shared by all three backends. */
export const keys = {
  statusCache: (slug: string) => `pw:status:${slug}`,
  rateLimit: (keyId: string, window: number) => `pw:rl:${keyId}:${window}`,
};
