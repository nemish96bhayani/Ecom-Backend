import { Domain, Tenant } from "../models/platform.js";
import { cached, invalidate } from "../lib/redis.js";
import { env } from "../config/env.js";

export type ResolvedTenant = { tenantId: string; status: string; hostname: string; primaryHost: string | null };

export const normalizeHost = (host: string) => host.toLowerCase().trim().replace(/:\d+$/, "").replace(/\.$/, "");

/** Host header → tenant. Cached in Redis for 5 minutes. */
export async function resolveTenantByHost(rawHost: string): Promise<ResolvedTenant | null> {
  const hostname = normalizeHost(rawHost);
  return cached(`host:${hostname}`, 300, async () => {
    let domain = await Domain.findOne({ hostname, status: { $in: ["verified", "active"] } }).lean();
    if (!domain) {
      // In local development or subdomain fallback: check if hostname matches <slug>.localhost or <slug>.<PLATFORM_DOMAIN>
      const match = hostname.match(/^([a-z0-9-]+)\.localhost$/) ?? (env.PLATFORM_DOMAIN ? hostname.match(new RegExp(`^([a-z0-9-]+)\\.${env.PLATFORM_DOMAIN.replace(/\./g, "\\.")}$`)) : null);
      if (match) {
        const slug = match[1];
        const tenantBySlug = await Tenant.findOne({ slug, status: "active" }).lean();
        if (tenantBySlug) {
          return { tenantId: String((tenantBySlug as any)._id), status: (tenantBySlug as any).status, hostname, primaryHost: hostname };
        }
      }
      return null;
    }
    const [tenant, primary] = await Promise.all([
      Tenant.findById(domain.tenantId).select("status").lean(),
      Domain.findOne({ tenantId: domain.tenantId, isPrimary: true, status: { $in: ["verified", "active"] } }).lean(),
    ]);
    if (!tenant) return null;
    return { tenantId: String(domain.tenantId), status: tenant.status, hostname, primaryHost: primary?.hostname ?? null };
  });
}

export async function tenantStatus(tenantId: string) {
  return cached(`tenant-status:${tenantId}`, 60, async () => (await Tenant.findById(tenantId).select("status").lean())?.status ?? null);
}

export async function invalidateTenantCaches(tenantId: string) {
  const domains = await Domain.find({ tenantId }).select("hostname").lean();
  await invalidate(`tenant-status:${tenantId}`, `store-config:${tenantId}`, ...domains.map((d) => `host:${d.hostname}`));
}
