import { Router } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Domain } from "../models/platform.js";
import { normalizeHost } from "../services/tenantLookup.js";
import { redis } from "../lib/redis.js";
import { buildOpenApi } from "../http/openapi.js";

const router = Router();
export default router;

router.get("/health", async (_req, res) => {
  const db = mongoose.connection.readyState === 1;
  const cache = await redis.ping().then(() => true).catch(() => false);
  res.status(db ? 200 : 503).json({ ok: db, db, cache });
});

/**
 * Caddy On-Demand TLS "ask" endpoint. Caddy calls this before issuing a certificate,
 * so certificates are only issued for verified store domains (prevents abuse).
 * Caddyfile:  on_demand_tls { ask http://api:4000/internal/caddy/ask }
 */
router.get("/internal/caddy/ask", async (req, res) => {
  const domain = normalizeHost(String(req.query.domain ?? ""));
  if (!domain) return res.status(400).end();
  if (domain === env.PLATFORM_DOMAIN || domain.endsWith(`.${env.PLATFORM_DOMAIN}`)) return res.status(200).end();
  const d = await Domain.findOne({ hostname: domain, status: { $in: ["verified", "active"] } }).lean();
  res.status(d ? 200 : 404).end();
});

router.get("/api/v1/openapi.json", (_req, res) => res.json(buildOpenApi()));
