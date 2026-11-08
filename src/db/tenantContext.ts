import { AsyncLocalStorage } from "node:async_hooks";

export type TenantStore = { tenantId?: string; bypass?: boolean; actor?: string };
export const tenantContext = new AsyncLocalStorage<TenantStore>();

export const currentTenantId = () => tenantContext.getStore()?.tenantId;

export function requireTenantId(): string {
  const id = currentTenantId();
  if (!id) throw new Error("No tenant context");
  return id;
}

/**
 * Run code scoped to a tenant (used by jobs, webhooks, scripts).
 * The result is awaited INSIDE the context: Mongoose queries are lazy thenables that only execute
 * when awaited, so returning an un-awaited query would otherwise run it outside the tenant scope.
 */
export const runAsTenant = <T>(tenantId: string, fn: () => T): Promise<Awaited<T>> =>
  tenantContext.run({ tenantId }, async (): Promise<Awaited<T>> => await fn());

/**
 * Explicit, auditable escape hatch for cross-tenant queries (super-admin reports, login lookup, jobs).
 * Never use this inside merchant or storefront routes.
 */
export const runWithoutTenant = <T>(reason: string, fn: () => T): Promise<Awaited<T>> =>
  tenantContext.run({ bypass: true, actor: reason }, async (): Promise<Awaited<T>> => await fn());
