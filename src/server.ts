import { env } from "./config/env.js";
import { connectDb } from "./db/connect.js";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";

async function main() {
  await connectDb();
  await redis.connect().catch((err) => logger.warn({ err }, "Redis not reachable – caching disabled until it is"));
  const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));
  const shutdown = () => {
    logger.info("Shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
