import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

mongoose.set("strictQuery", true);

export async function connectDb() {
  await mongoose.connect(env.MONGO_URL, { autoIndex: env.NODE_ENV !== "production" });
  logger.info("MongoDB connected");
}

/** Run work inside a MongoDB transaction (requires replica set – Atlas or docker-compose rs0). */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
