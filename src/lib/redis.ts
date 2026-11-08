import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

export async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* cache unavailable – fall through */
  }
  const value = await load();
  try {
    if (value !== null && value !== undefined) await redis.set(key, JSON.stringify(value), "EX", ttlSec);
  } catch {
    /* ignore */
  }
  return value;
}

export async function invalidate(...keys: string[]) {
  try {
    if (keys.length) await redis.del(...keys);
  } catch {
    /* ignore */
  }
}
