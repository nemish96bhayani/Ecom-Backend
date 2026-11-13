import { z } from "zod";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { moduleFor, slugify } from "./_shared.js";
import { Tenant, Domain, AuditLog, PlatformAdmin } from "../models/platform.js";
import { User, Cart } from "../models/people.js";
import { Category, Product, Coupon, Page } from "../models/catalog.js";
import { Order } from "../models/orders.js";
import { Statement, Commission } from "../models/billing.js";
import { idParams, objectId, pagination } from "../http/route.js";
import { notFound, badRequest, conflict } from "../lib/errors.js";
import { env } from "../config/env.js";
import { encryptSecret, randomToken } from "../lib/crypto.js";
import { runAsTenant } from "../db/tenantContext.js";
import { invalidateTenantCaches } from "../services/tenantLookup.js";
import { generateAllStatements, generateStatement, previousPeriod, statementPdf, periodRange, currentPeriod, closedPeriodError } from "../services/statements.js";
import { BLUEPRINTS, applyBlueprint, type BlueprintKey } from "../services/blueprints.js";

const { router, add } = moduleFor("Platform", "/api/v1/platform");
export default router;

const audit = (actor: string, action: string, tenantId?: any, meta?: unknown) => AuditLog.create({ actor, action, tenantId, meta });

/** Store subdomains: a single DNS label (letters, digits, inner hyphens, at most 63 characters). */
export const tenantSlug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and dashes only, not starting or ending with a dash");
const RESERVED_SLUGS = new Set(["www", "admin", "api", "stores", "app", "mail", "platform", "localhost", "static", "cdn", "assets", "status", "help", "support", "billing"]);
export const isReservedSlug = (slug: string) => RESERVED_SLUGS.has(slug);

add({
  method: "get", path: "/tenants", summary: "All stores with this month's numbers", auth: "platform",
  query: pagination.extend({ status: z.enum(["active", "suspended", "pending"]).optional() }),
  handler: async ({ query }) => {
    const f = query.status ? { status: query.status } : {};
    const tenants = await Tenant.find(f).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    const ids = tenants.map((t) => t._id);
    const monthStart = periodRange(currentPeriod()).start; // IST month, matching billing
    const [gmv, domains] = await Promise.all([
      Order.aggregate([
        { $match: { tenantId: { $in: ids }, createdAt: { $gte: monthStart }, status: { $in: ["confirmed", "packed", "shipped", "delivered"] } } },
        { $group: { _id: "$tenantId", orders: { $sum: 1 }, gmvPaise: { $sum: "$totals.totalPaise" } } },
      ]),
      Domain.find({ tenantId: { $in: ids } }).lean(),
    ]);
    const g = new Map(gmv.map((x) => [String(x._id), x]));
    return {
      items: tenants.map((t) => ({ ...t, monthToDate: g.get(String(t._id)) ?? { orders: 0, gmvPaise: 0 }, domains: domains.filter((d) => String(d.tenantId) === String(t._id)).map((d) => ({ hostname: d.hostname, status: d.status, isPrimary: d.isPrimary })) })),
      total: await Tenant.countDocuments(f),
    };
  },
});

add({
  method: "get", path: "/blueprints", summary: "List available starter blueprints", auth: "platform",
  handler: async () => Object.values(BLUEPRINTS),
});

add({
  method: "post", path: "/tenants", summary: "Create a store, its subdomain and owner account", auth: "platform",
  body: z.object({
    name: z.string().min(2),
    slug: tenantSlug,
    owner: z.object({ email: z.email(), name: z.string().min(1), password: z.string().min(10) }),
    commissionRatePercent: z.number().min(0).max(30).default(env.COMMISSION_RATE_PERCENT),
    monthlyFeePaise: z.number().int().min(0).default(0),
    business: z.object({ legalName: z.string(), gstin: z.string(), stateCode: z.string().regex(/^\d{2}$/), address: z.string(), email: z.string(), phone: z.string() }).partial().optional(),
    blueprint: z.enum(["none", "fashion", "grocery", "general"]).default("none").optional(),
    isDemo: z.boolean().default(false).optional(),
  }),
  handler: async ({ body, req }) => {
    const slug = slugify(body.slug);
    if (isReservedSlug(slug)) throw badRequest("That subdomain is reserved");
    const tenant = await Tenant.create({
      name: body.name,
      slug,
      blueprint: body.blueprint !== "none" ? body.blueprint : null,
      isDemo: !!body.isDemo,
      salesRepId: req.auth?.sub ? new Types.ObjectId(req.auth.sub) : null,
      plan: { commissionRatePercent: body.commissionRatePercent, monthlyFeePaise: body.monthlyFeePaise },
      business: { ...body.business, legalName: body.business?.legalName ?? body.name },
      credentials: {
        payment: { provider: "mock", mode: "sandbox", secret: encryptSecret(JSON.stringify({ apiKey: "mock_test_key" })) },
        shipping: { provider: "mock", secret: encryptSecret(JSON.stringify({ apiKey: "mock_test_key" })) },
      },
    });
    try {
      await Domain.create({ tenantId: tenant._id, hostname: `${slug}.${env.PLATFORM_DOMAIN}`, kind: "subdomain", status: "active", isPrimary: true });
      await Domain.create({ tenantId: tenant._id, hostname: `${slug}.localhost`, kind: "subdomain", status: "active" }).catch(() => undefined);
      await User.create({ tenantId: tenant._id, email: body.owner.email, name: body.owner.name, role: "owner", passwordHash: await bcrypt.hash(body.owner.password, 12) });
      if (body.blueprint && body.blueprint !== "none") {
        await applyBlueprint(String(tenant._id), body.blueprint as BlueprintKey);
      }
    } catch (e) {
      // Also remove whatever the blueprint managed to seed, scoped to this new tenant only.
      await runAsTenant(String(tenant._id), () =>
        Promise.all([Category.deleteMany({}), Product.deleteMany({}), Coupon.deleteMany({}), Page.deleteMany({})]),
      ).catch(() => undefined);
      await Promise.all([Tenant.deleteOne({ _id: tenant._id }), Domain.deleteMany({ tenantId: tenant._id }), User.deleteMany({ tenantId: tenant._id })]);
      throw e;
    }
    await audit(`platform:${req.auth!.sub}`, "tenant.created", tenant._id, { slug, blueprint: body.blueprint, isDemo: body.isDemo });
    return { tenant, storeUrl: `https://${slug}.${env.PLATFORM_DOMAIN}` };
  },
});

add({
  method: "get", path: "/tenants/:id", summary: "Store details", auth: "platform", params: idParams,
  handler: async ({ params }) => {
    const t = await Tenant.findById(params.id).lean();
    if (!t) throw notFound("Store");
    const [domains, users, statements] = await Promise.all([
      Domain.find({ tenantId: t._id }).lean(),
      User.find({ tenantId: t._id }).select("email name role isActive lastLoginAt").lean(),
      Statement.find({ tenantId: t._id }).sort({ period: -1 }).limit(12).lean(),
    ]);
    return { ...t, domains, users, statements };
  },
});

add({
  method: "patch", path: "/tenants/:id", summary: "Update plan, status or business details", auth: "platform", params: idParams,
  body: z.object({
    name: z.string().optional(),
    status: z.enum(["active", "suspended", "pending"]).optional(),
    commissionRatePercent: z.number().min(0).max(30).optional(),
    monthlyFeePaise: z.number().int().min(0).optional(),
    mandateStatus: z.enum(["none", "pending", "active", "failed"]).optional(),
    mandateRef: z.string().optional(),
    graceDays: z.number().int().min(0).max(60).optional(),
  }),
  handler: async ({ params, body, req }) => {
    const set: Record<string, unknown> = {};
    if (body.name) set.name = body.name;
    if (body.status) set.status = body.status;
    if (body.commissionRatePercent !== undefined) set["plan.commissionRatePercent"] = body.commissionRatePercent;
    if (body.monthlyFeePaise !== undefined) set["plan.monthlyFeePaise"] = body.monthlyFeePaise;
    if (body.mandateStatus) set["billing.mandateStatus"] = body.mandateStatus;
    if (body.mandateRef) set["billing.mandateRef"] = body.mandateRef;
    if (body.graceDays !== undefined) set["billing.graceDays"] = body.graceDays;
    const t = await Tenant.findByIdAndUpdate(params.id, { $set: set }, { new: true }).lean();
    if (!t) throw notFound("Store");
    if (body.status === "suspended") await User.updateMany({ tenantId: t._id }, { $inc: { authVersion: 1 } });
    await invalidateTenantCaches(params.id);
    await audit(`platform:${req.auth!.sub}`, "tenant.updated", t._id, body);
    return t;
  },
});

add({
  method: "get", path: "/dashboard", summary: "Platform totals: GMV, commission, overdue", auth: "platform",
  query: z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }),
  handler: async ({ query }) => {
    // Start of the IST month (months - 1) before the current one, matching the Asia/Kolkata buckets below.
    const [cy, cm] = currentPeriod().split("-").map(Number) as [number, number];
    const first = new Date(Date.UTC(cy, cm - query.months, 1));
    const since = periodRange(`${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`).start;
    const [byMonth, byTenant, overdue, accrued, tenants] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: since }, status: { $in: ["confirmed", "packed", "shipped", "delivered"] } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Kolkata" } }, orders: { $sum: 1 }, gmvPaise: { $sum: "$totals.totalPaise" } } },
        { $sort: { _id: 1 } },
      ]),
      Commission.aggregate([
        { $match: { accruedAt: { $gte: since }, status: { $in: ["accrued", "billed"] } } },
        { $group: { _id: "$tenantId", commissionPaise: { $sum: "$amountPaise" }, orders: { $sum: 1 } } },
        { $lookup: { from: "tenants", localField: "_id", foreignField: "_id", as: "t" } },
        { $project: { commissionPaise: 1, orders: 1, name: { $first: "$t.name" } } },
        { $sort: { commissionPaise: -1 } },
      ]),
      Statement.find({ status: { $in: ["due", "overdue"] }, dueDate: { $lt: new Date() } }).lean(),
      Commission.aggregate([{ $match: { status: "accrued" } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }]),
      Tenant.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    return { byMonth, byTenant, overdue, unbilledCommissionPaise: accrued[0]?.amountPaise ?? 0, tenants: Object.fromEntries(tenants.map((t) => [t._id, t.n])) };
  },
});

add({
  method: "get", path: "/statements", summary: "All commission statements", auth: "platform",
  query: z.object({ status: z.enum(["due", "paid", "overdue", "void"]).optional(), period: z.string().optional() }),
  handler: async ({ query }) => {
    const f: any = {};
    if (query.status) f.status = query.status;
    if (query.period) f.period = query.period;
    const list = await Statement.find(f).sort({ period: -1, createdAt: -1 }).limit(500).lean();
    const names = new Map((await Tenant.find({ _id: { $in: list.map((s) => s.tenantId) } }).select("name").lean()).map((t) => [String(t._id), t.name]));
    return list.map((s) => ({ ...s, tenantName: names.get(String(s.tenantId)) }));
  },
});

add({
  method: "post", path: "/statements/generate", summary: "Generate statements for a month (default: last month)", auth: "platform",
  body: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), tenantId: objectId.optional() }),
  handler: async ({ body, req }) => {
    const period = body.period ?? previousPeriod();
    // A month that hasn't ended would strand commission accrued later in it (generation is once per period).
    const problem = closedPeriodError(period);
    if (problem) throw badRequest(problem);
    let created: boolean;
    if (body.tenantId) {
      const existed = await Statement.exists({ tenantId: body.tenantId, period });
      const s = await generateStatement(body.tenantId, period);
      created = !!s && !existed;
    } else {
      created = (await generateAllStatements(period)) > 0;
    }
    await audit(`platform:${req.auth!.sub}`, "statements.generated", body.tenantId, { period, created });
    return { period, created };
  },
});

add({
  method: "post", path: "/statements/:id/mark-paid", summary: "Record a payment against a statement", auth: "platform", params: idParams,
  body: z.object({ paymentRef: z.string().min(2) }),
  handler: async ({ params, body, req }) => {
    const s = await Statement.findOneAndUpdate(
      { _id: params.id, status: { $in: ["due", "overdue"] } },
      { $set: { status: "paid", paidAt: new Date(), paymentRef: body.paymentRef }, $push: { attempts: { at: new Date(), result: "paid", note: body.paymentRef } } },
      { new: true },
    ).lean();
    if (!s) {
      const current = await Statement.findById(params.id).select("status").lean();
      if (!current) throw notFound("Statement");
      throw conflict(`This statement is already ${current.status}`);
    }
    await audit(`platform:${req.auth!.sub}`, "statement.paid", s.tenantId, { statementId: s._id, ref: body.paymentRef });
    return s;
  },
});

add({
  method: "get", path: "/statements/:id/invoice.pdf", summary: "Download a commission invoice", auth: "platform", params: idParams, raw: true,
  handler: async ({ params, res }) => {
    const s = await Statement.findById(params.id).lean();
    if (!s) throw notFound("Statement");
    const pdf = await statementPdf(String(s.tenantId), params.id);
    if (!pdf) throw notFound("Store for this statement");
    res.type("application/pdf").send(pdf);
  },
});

add({
  method: "get", path: "/audit", summary: "Audit log", auth: "platform", query: pagination,
  handler: ({ query }) => AuditLog.find().sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
});

add({
  method: "post", path: "/admins", summary: "Add another super-admin", auth: "platform",
  body: z.object({ email: z.email(), name: z.string(), password: z.string().min(12) }),
  handler: async ({ body, req }) => {
    const a = await PlatformAdmin.create({ email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) });
    await audit(`platform:${req.auth!.sub}`, "admin.created", undefined, { email: body.email });
    return { id: a._id, email: a.email };
  },
});

add({
  method: "post", path: "/tenants/:id/handover", summary: "Generate handover token for merchant onboarding", auth: "platform", params: idParams,
  handler: async ({ params, req }) => {
    const tenant = await Tenant.findById(params.id);
    if (!tenant) throw notFound("Store");
    const token = randomToken(24);
    (tenant as any).handoverToken = token;
    (tenant as any).handoverExpiresAt = new Date(Date.now() + 72 * 3600 * 1000);
    await tenant.save();
    await audit(`platform:${req.auth!.sub}`, "tenant.handover_initiated", tenant._id, { expiresAt: (tenant as any).handoverExpiresAt });
    return { token, expiresAt: (tenant as any).handoverExpiresAt, slug: tenant.slug };
  },
});

add({
  method: "post", path: "/tenants/:id/purge-demo-orders", summary: "Purge test demo orders before client launch", auth: "platform", params: idParams,
  handler: async ({ params, req }) => {
    const tenant = await Tenant.findById(params.id);
    if (!tenant) throw notFound("Store");
    await runAsTenant(String(tenant._id), async () => {
      await Promise.all([
        Order.deleteMany({ tenantId: tenant._id }),
        Cart.deleteMany({ tenantId: tenant._id }),
      ]);
    });
    await audit(`platform:${req.auth!.sub}`, "tenant.demo_orders_purged", tenant._id);
    return { ok: true, message: "Demo orders and carts purged successfully" };
  },
});
