import express from "express";
import path from "node:path";
import fs from "node:fs";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { timingSafeEqualStr } from "./lib/crypto.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import webhooks from "./modules/webhooks.js";
import internal from "./modules/internal.js";
import feeds from "./modules/feeds.js";
import merchantAuth from "./modules/merchantAuth.js";
import adminCatalog from "./modules/adminCatalog.js";
import adminOrders from "./modules/adminOrders.js";
import adminSettings from "./modules/adminSettings.js";
import adminAds from "./modules/adminAds.js";
import store from "./modules/store.js";
import platform from "./modules/platform.js";

/** Storefront requests come via the SSR proxy, which forwards the shopper's IP in x-shopper-ip. */
// x-shopper-ip is only trusted when the request carries the storefront's internal secret;
// otherwise anyone calling the API directly could pick their own rate-limit bucket.
const fromStorefront = (req: express.Request) => timingSafeEqualStr(req.header("x-internal-secret") ?? "", env.INTERNAL_PROXY_SECRET);
const clientIp = (req: express.Request) =>
  ipKeyGenerator((fromStorefront(req) ? req.header("x-shopper-ip") : undefined) || req.ip || "unknown");

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

  // Serve uploaded media in local development / storage fallback
  const uploadsDir = path.resolve(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use("/media", cors(), express.static(uploadsDir));

  // Webhooks first: they need the raw body, before express.json() runs.
  app.use(webhooks);
  app.use(internal);
  app.use(feeds);

  app.use(express.json({ limit: "6mb" }));
  app.use(cookieParser());

  // Only the admin panel calls the API from the browser. Storefront calls arrive server-to-server via its proxy.
  const origins = env.ADMIN_ORIGINS.split(",").map((s) => s.trim());
  app.use(["/api/v1/auth", "/api/v1/admin", "/api/v1/platform"], cors({ origin: origins, credentials: true }));

  app.use("/api/v1/auth", rateLimit({ windowMs: 15 * 60_000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/api/v1/store/auth", rateLimit({ windowMs: 10 * 60_000, limit: 30, keyGenerator: (req) => `${clientIp(req)}:${req.header("x-store-host")}` }));
  app.use("/api/v1", rateLimit({ windowMs: 60_000, limit: 600, keyGenerator: (req) => clientIp(req) }));

  app.use(merchantAuth);
  app.use(adminCatalog);
  app.use(adminOrders);
  app.use(adminSettings);
  app.use(adminAds);
  app.use(store);
  app.use(platform);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
