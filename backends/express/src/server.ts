import { createServer } from "node:http";
import { config } from "./config";
import { createApp } from "./app";
import { pool } from "./db";
import { redis } from "./redis";
import { startWorkers } from "./worker";

const server = createServer(createApp());
server.listen(config.port, () => console.log(`pulsewatch express backend listening on :${config.port}`));
const stopWorkers = startWorkers();

const shutdown = () => {
  stopWorkers();
  server.close(() => {
    void Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
