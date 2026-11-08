import { z } from "zod";
import dns from "node:dns/promises";
import { moduleFor } from "./_shared.js";
import { Tenant, Domain, AuditLog } from "../models/platform.js";
import { Statement, Commission } from "../models/billing.js";
import { idParams } from "../http/route.js";
import { notFound, badRequest, conflict } from "../lib/errors.js";
import { requireTenantId, runWithoutTenant } from "../db/tenantContext.js";
import { randomToken, encryptSecret } from "../lib/crypto.js";
import { env } from "../config/env.js";
import { invalidateTenantCaches, normalizeHost } from "../services/tenantLookup.js";
import { savePaymentConfig, getPaymentProvider } from "../integrations/payments/index.js";
import { saveShippingConfig, getShippingProvider } from "../integrations/shipping/index.js";
import { statementPdf } from "../services/statements.js";

const { router, add } = moduleFor("Settings", "/api/v1/admin");
export default router;

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #0E4D4A");

const settingsBody = z.object({
  name: z.string().min(1).optional(),
  business: z.object({
    legalName: z.string().optional(), gstin: z.string().optional(), pan: z.string().optional(),
    stateCode: z.string().regex(/^\d{2}$/).optional(), address: z.string().optional(), email: z.string().optional(), phone: z.string().optional(),
    grievanceOfficer: z.object({ name: z.string(), email: z.string(), phone: z.string() }).partial().optional(),
  }).partial().optional(),
  settings: z.object({
    theme: z.enum(["general", "fashion", "grocery"]),
    colors: z.object({ primary: hex, accent: hex, background: hex, text: hex }).partial(),
    font: z.string(),
    logoUrl: z.string(),
    faviconUrl: z.string(),
    banners: z.array(z.object({ imageUrl: z.string(), title: z.string().optional(), subtitle: z.string().optional(), link: z.string().optional() })),
    homeSections: z.array(z.enum(["hero", "categories", "featured", "new", "about", "testimonials"])),
    whatsappNumber: z.string(),
    social: z.object({ instagram: z.string(), facebook: z.string(), youtube: z.string() }).partial(),
    seo: z.object({ title: z.string(), description: z.string() }).partial(),
    checkout: z.object({ codEnabled: z.boolean(), codMaxPaise: z.number().int(), prepaidDiscountPaise: z.number().int().min(0), freeShippingAbovePaise: z.number().int().min(0), flatShippingPaise: z.number().int().min(0), codFeePaise: z.number().int().min(0) }).partial(),
    shippingOrigin: z.object({ pickupLocation: z.string(), pincode: z.string(), defaultWeightKg: z.number().positive(), dims: z.object({ l: z.number(), b: z.number(), h: z.number() }) }).partial(),
    tracking: z.object({ metaPixelId: z.string(), ga4Id: z.string(), googleAdsId: z.string() }).partial(),
  }).partial().optional(),
});

/** Flattens nested objects into dot paths so partial updates don't wipe sibling fields. */
function toSet(prefix: string, obj: Record<string, any>, out: Record<string, any> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) toSet(path, v, out);
    else if (v !== undefined) out[path] = v;
  }
  return out;
}

add({
  method: "get", path: "/settings", summary: "Store settings", auth: "merchant",
  handler: async () => {
    const t = await Tenant.findById(requireTenantId()).select("+credentials").lean();
    if (!t) throw notFound("Store");
    const { credentials, ...rest } = t as any;
    return {
      ...rest,
      integrations: {
        payment: { provider: credentials?.payment?.provider ?? null, mode: credentials?.payment?.mode ?? null, connected: !!credentials?.payment?.secret },
        shipping: { provider: credentials?.shipping?.provider ?? null, connected: !!credentials?.shipping?.secret },
        metaCapi: { connected: !!credentials?.meta?.secret },
      },
    };
  },
});

add({
  method: "patch", path: "/settings", summary: "Update store settings", auth: "owner", body: settingsBody,
  handler: async ({ body }) => {
    const tenantId = requireTenantId();
    const set = toSet("", body);
    if (!Object.keys(set).length) throw badRequest("Nothing to update");
    await Tenant.updateOne({ _id: tenantId }, { $set: set }, { runValidators: true });
    await invalidateTenantCaches(tenantId);
    return Tenant.findById(tenantId).lean();
  },
});

add({
  method: "put", path: "/settings/payments", summary: "Connect your payment gateway account", auth: "owner",
  body: z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("cashfree"), mode: z.enum(["sandbox", "production"]), credentials: z.object({ appId: z.string().min(4), secretKey: z.string().min(8) }) }),
    z.object({ provider: z.literal("razorpay"), mode: z.enum(["sandbox", "production"]), credentials: z.object({ keyId: z.string().min(4), keySecret: z.string().min(8), webhookSecret: z.string().min(8) }) }),
    z.object({ provider: z.literal("mock"), mode: z.enum(["sandbox", "production"]).default("sandbox"), credentials: z.object({ apiKey: z.string().default("mock_test_key") }).default({ apiKey: "mock_test_key" }) }),
  ]),
  handler: async ({ body, req }) => {
    const tenantId = requireTenantId();
    await savePaymentConfig(tenantId, body as any);
    await runWithoutTenant("audit", () => AuditLog.create({ actor: `user:${req.auth!.sub}`, action: "payments.connected", tenantId, meta: { provider: body.provider, mode: body.mode } }));
    return { provider: body.provider, mode: body.mode, webhookUrl: `${env.PUBLIC_API_URL}/api/v1/webhooks/payments/${body.provider}/${tenantId}` };
  },
});

add({
  method: "post", path: "/settings/payments/test", summary: "Check the gateway credentials work", auth: "owner",
  handler: async () => {
    const p = await getPaymentProvider(requireTenantId());
    try {
      await p.fetchStatus("connection-test-order");
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (e?.status === 401 || (e?.status === 502 && /auth|credential|unauthori[sz]ed|invalid_client/i.test(msg))) {
        throw badRequest("The gateway rejected these keys. Check your App ID / Secret and try again.");
      }
    }
    return { ok: true, provider: p.name };
  },
});

add({
  method: "put", path: "/settings/shipping", summary: "Connect your shipping provider", auth: "owner",
  body: z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("shiprocket"), email: z.email(), password: z.string().min(4) }),
    z.object({ provider: z.literal("mock"), testMode: z.boolean().default(true) }),
  ]),
  handler: async ({ body }) => {
    const tenantId = requireTenantId();
    const webhookToken = randomToken(18);
    if (body.provider === "shiprocket") {
      await saveShippingConfig(tenantId, "shiprocket", { email: body.email, password: body.password, webhookToken });
    } else {
      await runWithoutTenant("save-mock-shipping", () =>
        Tenant.updateOne({ _id: tenantId }, { $set: { "credentials.shipping": { provider: "mock", secret: encryptSecret(JSON.stringify({ mock: true })) } } }),
      );
    }
    return { provider: body.provider, webhookUrl: `${env.PUBLIC_API_URL}/api/v1/webhooks/shipping/${body.provider}/${tenantId}`, webhookToken };
  },
});

add({
  method: "post", path: "/settings/shipping/serviceability", summary: "Check delivery to a pincode", auth: "merchant",
  body: z.object({ pincode: z.string().regex(/^\d{6}$/), weightKg: z.number().positive().default(0.5), cod: z.boolean().default(false) }),
  handler: async ({ body }) => {
    const tenantId = requireTenantId();
    const t = await Tenant.findById(tenantId).lean();
    const origin = t?.settings?.shippingOrigin?.pincode;
    if (!origin) throw badRequest("Set your pickup pincode in Settings → Shipping first");
    return (await getShippingProvider(tenantId)).checkServiceability({ pickupPincode: origin, deliveryPincode: body.pincode, weightKg: body.weightKg, cod: body.cod });
  },
});

add({
  method: "put", path: "/settings/meta-capi", summary: "Save Meta Conversions API access token", auth: "owner",
  body: z.object({ accessToken: z.string().min(20) }),
  handler: async ({ body }) => {
    await Tenant.updateOne({ _id: requireTenantId() }, { $set: { "credentials.meta.secret": encryptSecret(body.accessToken) } });
    return { ok: true };
  },
});

// ---------- Domains ----------
add({
  method: "get", path: "/domains", summary: "List store domains with DNS instructions", auth: "merchant",
  handler: async () => {
    const domains = await Domain.find({ tenantId: requireTenantId() }).sort({ kind: 1, createdAt: 1 }).lean();
    return domains.map((d) => ({
      ...d,
      dns: d.kind === "custom"
        ? [
            { type: "TXT", name: `_verify.${d.hostname}`, value: d.verificationToken },
            d.hostname.split(".").length > 2
              ? { type: "CNAME", name: d.hostname, value: env.STORES_CNAME_TARGET }
              : { type: "A / ALIAS", name: d.hostname, value: `Point to the IP of ${env.STORES_CNAME_TARGET} (or use ALIAS/CNAME flattening)` },
          ]
        : [],
    }));
  },
});

add({
  method: "post", path: "/domains", summary: "Add a custom domain", auth: "owner",
  body: z.object({ hostname: z.string().min(4).regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "Enter a domain like www.mystore.com") }),
  handler: async ({ body }) => {
    const hostname = normalizeHost(body.hostname);
    if (hostname.endsWith(env.PLATFORM_DOMAIN)) throw badRequest("Use your own domain, not a platform subdomain");
    const exists = await Domain.findOne({ hostname }).lean();
    if (exists) throw conflict("This domain is already connected to a store");
    return Domain.create({ tenantId: requireTenantId(), hostname, kind: "custom", status: "pending", verificationToken: `verify-${randomToken(16)}` });
  },
});

add({
  method: "post", path: "/domains/:id/verify", summary: "Check DNS records and activate the domain", auth: "owner", params: idParams,
  handler: async ({ params }) => {
    const tenantId = requireTenantId();
    const d = await Domain.findOne({ _id: params.id, tenantId });
    if (!d) throw notFound("Domain");

    d.lastCheckedAt = new Date();

    // 1. Local development bypass: if .localhost or in dev environment
    if (env.NODE_ENV !== "production" && (d.hostname.endsWith(".localhost") || d.hostname.includes("localhost"))) {
      d.status = "active";
      d.lastError = undefined;
      await d.save();
      await invalidateTenantCaches(tenantId);
      return { status: d.status, verified: true, message: "Local development domain activated." };
    }

    // 2. Check CNAME resolution
    let cnameMatches = false;
    try {
      const cnames = await dns.resolveCname(d.hostname);
      const target = normalizeHost(env.STORES_CNAME_TARGET);
      cnameMatches = cnames.some((c) => {
        const norm = normalizeHost(c);
        return norm === target || norm.endsWith(`.${target}`);
      });
    } catch {
      // CNAME not configured or root A record
    }

    // 3. Check TXT record verification
    let txtMatches = false;
    try {
      const txt = (await dns.resolveTxt(`_verify.${d.hostname}`)).map((r) => r.join(""));
      txtMatches = txt.includes(d.verificationToken ?? "");
    } catch {
      // TXT not configured
    }

    if (!cnameMatches && !txtMatches) {
      d.lastError = `DNS record not detected. Either point a CNAME to ${env.STORES_CNAME_TARGET} or add a TXT record for _verify.${d.hostname}. Note: DNS propagation can take 15–30 minutes.`;
      await d.save();
      return { status: d.status, verified: false, message: d.lastError };
    }

    d.status = "active";
    d.lastError = undefined;
    await d.save();
    await invalidateTenantCaches(tenantId);
    return { status: d.status, verified: true, message: "Domain verified and active! SSL certificate will be issued automatically via Caddy On-Demand TLS." };
  },
});

add({
  method: "post", path: "/domains/:id/primary", summary: "Make this the main domain (others redirect to it)", auth: "owner", params: idParams,
  handler: async ({ params }) => {
    const tenantId = requireTenantId();
    const d = await Domain.findOne({ _id: params.id, tenantId });
    if (!d) throw notFound("Domain");
    if (d.status !== "active" && d.status !== "verified") throw badRequest("Verify the domain first");
    await Domain.updateMany({ tenantId }, { $set: { isPrimary: false } });
    d.isPrimary = true;
    await d.save();
    await invalidateTenantCaches(tenantId);
    return { ok: true };
  },
});

add({
  method: "delete", path: "/domains/:id", summary: "Remove a custom domain", auth: "owner", params: idParams,
  handler: async ({ params }) => {
    const tenantId = requireTenantId();
    const d = await Domain.findOne({ _id: params.id, tenantId });
    if (!d) throw notFound("Domain");
    if (d.kind === "subdomain") throw badRequest("The platform subdomain can't be removed");
    await invalidateTenantCaches(tenantId);
    await d.deleteOne();
    return { ok: true };
  },
});

// ---------- Billing (platform commission) ----------
add({
  method: "get", path: "/billing", summary: "Commission summary and statements", auth: "owner",
  handler: async () => {
    const tenant = await Tenant.findById(requireTenantId()).select("plan billing").lean();
    const [statements, accrued] = await Promise.all([
      Statement.find().sort({ period: -1 }).limit(24).lean(),
      Commission.aggregate([{ $match: { status: "accrued" } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, orders: { $sum: 1 }, basePaise: { $sum: "$basePaise" } } }]),
    ]);
    return { plan: tenant?.plan, billing: tenant?.billing, currentPeriod: accrued[0] ?? { amountPaise: 0, orders: 0, basePaise: 0 }, statements };
  },
});

add({
  method: "get", path: "/billing/commissions", summary: "Commission line items", auth: "owner",
  query: z.object({ status: z.enum(["accrued", "reversed", "billed"]).optional(), statementId: z.string().optional() }),
  handler: ({ query }) => Commission.find({ ...(query.status ? { status: query.status } : {}), ...(query.statementId ? { statementId: query.statementId } : {}) }).sort({ accruedAt: -1 }).limit(500).lean(),
});

add({
  method: "get", path: "/billing/statements/:id/invoice.pdf", summary: "Download commission invoice", auth: "owner", params: idParams, raw: true,
  handler: async ({ params, res }) => {
    const pdf = await statementPdf(requireTenantId(), params.id);
    if (!pdf) throw notFound("Statement");
    res.type("application/pdf").send(pdf);
  },
});
