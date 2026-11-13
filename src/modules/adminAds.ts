import { z } from "zod";
import { moduleFor, sentKeys, escapeRegex, queryDateFrom, queryDateTo, clearableDate } from "./_shared.js";
import { AdAccount, Campaign } from "../models/billing.js";
import { Order } from "../models/orders.js";
import { Tenant } from "../models/platform.js";
import { idParams } from "../http/route.js";
import { notFound, conflict } from "../lib/errors.js";
import { requireTenantId } from "../db/tenantContext.js";
import { env } from "../config/env.js";
import { feedToken } from "./feeds.js";

const { router, add } = moduleFor("Ads", "/api/v1/admin/ads");
export default router;

add({ method: "get", path: "/accounts", summary: "Connected ad accounts", auth: "merchant", handler: () => AdAccount.find().lean() });
add({
  method: "post", path: "/accounts", summary: "Record a client-owned ad account", auth: "owner",
  body: z.object({ platform: z.enum(["meta", "google"]), accountId: z.string().min(3), accountName: z.string().optional() }),
  handler: ({ body }) => AdAccount.create(body),
});
add({ method: "delete", path: "/accounts/:id", summary: "Remove ad account", auth: "owner", params: idParams, handler: async ({ params }) => { await AdAccount.deleteOne({ _id: params.id }); return { ok: true }; } });

const campaignBody = z.object({
  platform: z.enum(["meta", "google", "other"]),
  name: z.string().trim().min(1).max(200),
  utmCampaign: z.string().max(100).regex(/^[a-z0-9_-]+$/i, "Use letters, numbers, - or _"),
  status: z.enum(["draft", "active", "paused", "ended"]).default("active"),
  startDate: clearableDate.optional(),
  endDate: clearableDate.optional(),
  budgetPaise: z.number().int().min(0).optional(),
  notes: z.string().max(5000).optional(),
});

/** Orders are matched to campaigns by utm_campaign ignoring case, so two campaigns can't differ only by case. */
async function assertUtmFree(utmCampaign: string, exceptId?: string) {
  const clash = await Campaign.findOne({ utmCampaign: new RegExp(`^${escapeRegex(utmCampaign)}$`, "i"), ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).lean();
  if (clash) throw conflict(`Campaign "${clash.name}" already uses utm_campaign "${clash.utmCampaign}"`);
}

add({ method: "get", path: "/campaigns", summary: "List campaigns", auth: "merchant", handler: () => Campaign.find().sort({ createdAt: -1 }).lean() });
add({ method: "post", path: "/campaigns", summary: "Create campaign", auth: "merchant", body: campaignBody,
  handler: async ({ body }) => {
    await assertUtmFree(body.utmCampaign);
    return Campaign.create(body);
  },
});
add({
  method: "patch", path: "/campaigns/:id", summary: "Update campaign", auth: "merchant", params: idParams, body: campaignBody.partial(),
  handler: async ({ params, body, req }) => {
    const patch = sentKeys(body, req.body);
    if (patch.utmCampaign) await assertUtmFree(patch.utmCampaign, params.id);
    return (await Campaign.findByIdAndUpdate(params.id, { $set: patch }, { new: true }).lean()) ?? Promise.reject(notFound("Campaign"));
  },
});
add({
  method: "post", path: "/campaigns/:id/spend", summary: "Add daily spend (manual entry or import)", auth: "merchant", params: idParams,
  body: z.object({ entries: z.array(z.object({ date: z.coerce.date(), amountPaise: z.number().int().min(0), impressions: z.number().int().min(0).optional(), clicks: z.number().int().min(0).optional() })).min(1).max(400) }),
  handler: async ({ params, body }) => {
    const c = await Campaign.findById(params.id);
    if (!c) throw notFound("Campaign");
    for (const e of body.entries) {
      const day = e.date.toISOString().slice(0, 10);
      const i = c.spend.findIndex((s) => s.date?.toISOString().slice(0, 10) === day);
      if (i >= 0) c.spend.splice(i, 1);
      c.spend.push(e as any);
    }
    await c.save();
    return c;
  },
});

/** Campaign performance: spend from entries, orders/revenue matched by utm_campaign. */
add({
  method: "get", path: "/report", summary: "Campaign performance (spend, orders, revenue, ROAS)", auth: "merchant",
  query: z.object({ from: queryDateFrom.optional(), to: queryDateTo.optional() }),
  handler: async ({ query }) => {
    const from = query.from ?? new Date(Date.now() - 30 * 86_400_000);
    const to = query.to ?? new Date();
    const campaigns = await Campaign.find().lean();
    const revenue = await Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, status: { $in: ["confirmed", "packed", "shipped", "delivered"] }, "utm.campaign": { $exists: true, $ne: null } } },
      { $group: { _id: { $toLower: "$utm.campaign" }, orders: { $sum: 1 }, revenuePaise: { $sum: "$totals.totalPaise" } } },
    ]);
    const byUtm = new Map(revenue.map((r) => [r._id, r]));
    const rows = campaigns.map((c) => {
      const spendPaise = (c.spend ?? []).filter((s) => s.date && s.date >= from && s.date <= to).reduce((s, e) => s + (e.amountPaise ?? 0), 0);
      const r = byUtm.get(c.utmCampaign.toLowerCase());
      const revenuePaise = r?.revenuePaise ?? 0;
      return { id: c._id, name: c.name, platform: c.platform, utmCampaign: c.utmCampaign, status: c.status, spendPaise, orders: r?.orders ?? 0, revenuePaise, roas: spendPaise ? Math.round((revenuePaise / spendPaise) * 100) / 100 : null };
    });
    const known = new Set(campaigns.map((c) => c.utmCampaign.toLowerCase()));
    const untracked = revenue.filter((r) => !known.has(r._id));
    return { from, to, rows, untracked };
  },
});

add({
  method: "get", path: "/feeds", summary: "Product feed URLs for Meta Catalog and Google Merchant Center", auth: "merchant",
  handler: async () => {
    const tenantId = requireTenantId();
    const t = await Tenant.findById(tenantId).select("settings.tracking").lean();
    const token = feedToken(tenantId);
    return {
      meta: `${env.PUBLIC_API_URL}/api/v1/feeds/${tenantId}/${token}/meta.csv`,
      google: `${env.PUBLIC_API_URL}/api/v1/feeds/${tenantId}/${token}/google.tsv`,
      tracking: t?.settings?.tracking ?? {},
      utmExample: "?utm_source=facebook&utm_medium=paid&utm_campaign=diwali_sale",
    };
  },
});
