import { env } from "./config/env.js";
import { connectDb } from "./db/connect.js";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import mongoose from "mongoose";

async function main() {
  await connectDb();
  await redis.connect().catch((err) => logger.warn({ err }, "Redis not reachable – caching disabled until it is"));
  const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down: finishing in-flight requests");
    // Stop accepting new connections, let current requests finish, then close DB and Redis.
    server.close(async () => {
      await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
