import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { forbidden, unauthorized, AppError } from "../lib/errors.js";
import { timingSafeEqualStr } from "../lib/crypto.js";
import { verifyAccess, verifyCustomer, type AccessClaims, type CustomerClaims } from "../lib/jwt.js";
import { tenantContext, runAsTenant } from "../db/tenantContext.js";
import { User } from "../models/people.js";
import { resolveTenantByHost, tenantStatus, type ResolvedTenant } from "../services/tenantLookup.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      customer?: CustomerClaims;
      store?: ResolvedTenant;
    }
  }
}

const bearer = (req: Request) => {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
};

type MerchantUserState = { role: "owner" | "staff"; isActive: boolean; authVersion: number };
const USER_TTL_MS = 30_000;
const userCache = new Map<string, { at: number; state: MerchantUserState | null }>();

/**
 * Current role / active flag / authVersion of a merchant user, cached in memory for 30s per user.
 * The JWT's role is only a hint: demoted or deactivated staff lose access within the cache window
 * instead of keeping it until their 15-minute access token expires.
 */
async function merchantUserState(userId: string, tenantId: string, fresh = false): Promise<MerchantUserState | null> {
  const hit = userCache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < USER_TTL_MS) return hit.state;
  const u = await runAsTenant(tenantId, () => User.findById(userId).select("role isActive authVersion").lean());
  const state = u ? { role: (u.role ?? "staff") as "owner" | "staff", isActive: u.isActive !== false, authVersion: u.authVersion ?? 0 } : null;
  if (userCache.size > 10_000) userCache.clear();
  userCache.set(userId, { at: Date.now(), state });
  return state;
}

/** Drop a user's cached state after changing their role, active flag or authVersion (same process; others expire in 30s). */
export const invalidateMerchantUser = (userId: string) => void userCache.delete(userId);

/** Admin panel: merchant access token → tenant context. */
export function merchantGuard(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return next(unauthorized());
  let claims: AccessClaims;
  try {
    claims = verifyAccess(token);
  } catch {
    return next(unauthorized("Your session expired. Sign in again."));
  }
  if (claims.kind !== "merchant") return next(forbidden());
  Promise.all([tenantStatus(claims.tenantId), merchantUserState(claims.sub, claims.tenantId)])
    .then(async ([status, cachedUser]) => {
      let user = cachedUser;
      // A version mismatch may just be a stale cache (e.g. signed in again on another API instance): re-read once.
      if (user && claims.ver !== undefined && claims.ver !== user.authVersion) user = await merchantUserState(claims.sub, claims.tenantId, true);
      if (status !== "active") return next(new AppError(423, "tenant_suspended", "This store is suspended. Contact platform support."));
      if (!user || !user.isActive) return next(unauthorized("Your account is no longer active. Sign in again."));
      if (claims.ver !== undefined && claims.ver !== user.authVersion) return next(unauthorized("Your session expired. Sign in again."));
      req.auth = { ...claims, role: user.role };
      tenantContext.run({ tenantId: claims.tenantId, actor: `user:${claims.sub}` }, () => next());
    })
    .catch(next);
}

export function ownerGuard(req: Request, res: Response, next: NextFunction) {
  merchantGuard(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.auth?.kind === "merchant" && req.auth.role !== "owner") return next(forbidden("Only the store owner can do this"));
    next();
  });
}

/** Super-admin: runs with an explicit cross-tenant bypass, recorded as the actor. */
export function platformGuard(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return next(unauthorized());
  try {
    const claims = verifyAccess(token);
    if (claims.kind !== "platform") return next(forbidden());
    req.auth = claims;
    tenantContext.run({ bypass: true, actor: `platform:${claims.sub}` }, () => next());
  } catch {
    next(unauthorized("Your session expired. Sign in again."));
  }
}

/**
 * Storefront traffic arrives only through the storefront SSR proxy, which adds
 * x-internal-secret and x-store-host (the domain the shopper is on).
 */
export function storeGuard(req: Request, _res: Response, next: NextFunction) {
  const secret = req.header("x-internal-secret") ?? "";
  if (!timingSafeEqualStr(secret, env.INTERNAL_PROXY_SECRET)) return next(forbidden("Store requests must come through the storefront"));
  const host = req.header("x-store-host");
  if (!host) return next(new AppError(400, "missing_host", "x-store-host header missing"));
  resolveTenantByHost(host)
    .then((store) => {
      if (!store) return next(new AppError(404, "store_not_found", "No store is connected to this domain"));
      if (store.status !== "active") return next(new AppError(423, "store_unavailable", "This store is temporarily unavailable"));
      req.store = store;
      tenantContext.run({ tenantId: store.tenantId, actor: "storefront" }, () => next());
    })
    .catch(next);
}

const customerToken = (req: Request) => bearer(req) ?? req.cookies?.cs_token;

function attachCustomer(req: Request, required: boolean, next: NextFunction) {
  const token = customerToken(req);
  if (!token) return next(required ? unauthorized() : undefined);
  try {
    const c = verifyCustomer(token);
    if (c.tenantId !== req.store?.tenantId) return next(required ? unauthorized() : undefined);
    req.customer = c;
    next();
  } catch {
    next(required ? unauthorized("Your session expired. Sign in again.") : undefined);
  }
}

export function customerGuard(req: Request, res: Response, next: NextFunction) {
  storeGuard(req, res, (err?: unknown) => (err ? next(err) : attachCustomer(req, true, next)));
}
export function customerOptionalGuard(req: Request, res: Response, next: NextFunction) {
  storeGuard(req, res, (err?: unknown) => (err ? next(err) : attachCustomer(req, false, next)));
}

export const guards = {
  merchant: merchantGuard,
  owner: ownerGuard,
  platform: platformGuard,
  internal: storeGuard,
  customer: customerGuard,
  "customer-optional": customerOptionalGuard,
};
