import dns from "node:dns/promises";
import { runAsTenant, runWithoutTenant } from "../db/tenantContext.js";
import { Order } from "../models/orders.js";
import { Tenant, Domain } from "../models/platform.js";
import { Statement } from "../models/billing.js";
import { sendEmail, sendMessage } from "../integrations/notifications/index.js";
import { sendMetaPurchase } from "../integrations/ads/meta.js";
import { decryptSecret } from "../lib/crypto.js";
import { formatINR } from "../lib/money.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { transitionOrder } from "../services/orders.js";
import { generateAllStatements } from "../services/statements.js";
import { invalidateTenantCaches } from "../services/tenantLookup.js";
import type { NotificationJob } from "./queues.js";

const STATUS_COPY: Record<string, string> = {
  packed: "is packed and will be picked up by the courier soon",
  shipped: "has been shipped",
  delivered: "has been delivered",
  cancelled: "has been cancelled",
  rto: "couldn't be delivered and is returning to the store",
  refunded: "has been refunded",
};

export async function processNotification(job: NotificationJob) {
  const tenant = await runWithoutTenant("notify", () => Tenant.findById(job.tenantId).select("+credentials").lean());
  if (!tenant) return;
  if (job.type === "otp") {
    await sendMessage("sms", job.phone, "otp", { code: job.code, store: job.storeName });
    return;
  }
  await runAsTenant(job.tenantId, async () => {
    const order = await Order.findById(job.orderId).lean();
    if (!order) return;
    const name = order.customer?.name ?? "there";
    const host = (await runWithoutTenant("notify", () => Domain.findOne({ tenantId: job.tenantId, isPrimary: true }).lean()))?.hostname;
    const link = host ? `https://${host}/orders/${order._id}` : "";
    switch (job.type) {
      case "order_placed":
        await sendMessage("whatsapp", order.customer!.phone!, "order_placed", { name, order: order.number, total: formatINR(order.totals!.totalPaise!), link });
        if (order.customer?.email) await sendEmail(order.customer.email, `${tenant.name}: order ${order.number} confirmed`, `<p>Hi ${name},</p><p>Your order <b>${order.number}</b> for ${formatINR(order.totals!.totalPaise!)} is confirmed.</p><p><a href="${link}">Track your order</a></p>`);
        if (tenant.business?.email) await sendEmail(tenant.business.email, `New order ${order.number}`, `<p>New ${order.payment?.method === "cod" ? "COD" : "prepaid"} order ${order.number} for ${formatINR(order.totals!.totalPaise!)}.</p>`);
        break;
      case "order_status": {
        const copy = STATUS_COPY[job.status];
        if (!copy) return;
        const extra = job.status === "shipped" && order.shipment?.trackingUrl ? ` Track it: ${order.shipment.trackingUrl}` : "";
        await sendMessage("whatsapp", order.customer!.phone!, `order_${job.status}`, { name, order: order.number, text: `Your order ${order.number} ${copy}.${extra}` });
        if (order.customer?.email) await sendEmail(order.customer.email, `${tenant.name}: order ${order.number} update`, `<p>Hi ${name}, your order ${order.number} ${copy}.${extra}</p>`);
        break;
      }
      case "cod_confirm_request":
        await sendMessage("whatsapp", order.customer!.phone!, "cod_confirm", { name, order: order.number, total: formatINR(order.totals!.totalPaise!), link: job.confirmUrl });
        break;
      case "meta_purchase": {
        const pixelId = tenant.settings?.tracking?.metaPixelId;
        const tokenEnc = (tenant as any).credentials?.meta?.secret;
        if (!pixelId || !tokenEnc) return;
        await sendMetaPurchase({ pixelId, accessToken: decryptSecret(tokenEnc), eventId: String(order._id), valuePaise: order.totals!.totalPaise!, phone: order.customer?.phone ?? undefined, email: order.customer?.email ?? undefined, sourceUrl: link, fbclid: order.utm?.fbclid ?? undefined });
        break;
      }
    }
  });
}

/** Releases stock held by online orders whose payment never completed. */
export async function releaseExpiredOrders() {
  const expired = await runWithoutTenant("expire-orders", () => Order.find({ status: "pending_payment", expiresAt: { $lt: new Date() } }).select("_id tenantId").limit(500).lean());
  for (const o of expired) {
    await runAsTenant(String(o.tenantId), () => transitionOrder(String(o._id), "payment_failed", { by: "system", note: "Payment not completed in time" })).catch((err) => logger.warn({ err, orderId: o._id }, "Expire order failed"));
  }
  return expired.length;
}

export async function monthlyBilling() {
  await generateAllStatements();
}

/** Marks unpaid statements overdue and notifies; suspends ad services is a manual business decision (flagged). */
export async function dunning() {
  const due = await runWithoutTenant("dunning", () => Statement.find({ status: "due", dueDate: { $lt: new Date() } }).lean());
  for (const s of due) {
    await runWithoutTenant("dunning", () => Statement.updateOne({ _id: s._id }, { $set: { status: "overdue" }, $push: { attempts: { at: new Date(), result: "overdue" } } }));
    const t = await runWithoutTenant("dunning", () => Tenant.findById(s.tenantId).lean());
    if (t?.business?.email) await sendEmail(t.business.email, `Invoice ${s.invoiceNumber} is overdue`, `<p>Your platform invoice ${s.invoiceNumber} for ${formatINR(s.totalPaise ?? 0)} is overdue. Pay it to avoid interruption of services.</p>`);
  }
  return due.length;
}

export async function domainHealth() {
  const domains = await runWithoutTenant("domain-health", () => Domain.find({ kind: "custom", status: { $in: ["active", "error"] } }).lean());
  for (const d of domains) {
    let ok = false;
    try {
      const cname = await dns.resolveCname(d.hostname).catch(() => [] as string[]);
      const a = cname.length ? [] : await dns.resolve4(d.hostname).catch(() => [] as string[]);
      const target = await dns.resolve4(env.STORES_CNAME_TARGET).catch(() => [] as string[]);
      ok = cname.some((c) => c.replace(/\.$/, "") === env.STORES_CNAME_TARGET) || a.some((ip) => target.includes(ip));
    } catch {
      ok = false;
    }
    const status = ok ? "active" : "error";
    if (status !== d.status) {
      await runWithoutTenant("domain-health", () => Domain.updateOne({ _id: d._id }, { $set: { status, lastCheckedAt: new Date(), lastError: ok ? undefined : "DNS no longer points to the platform" } }));
      await invalidateTenantCaches(String(d.tenantId));
      logger.warn({ hostname: d.hostname, status }, "Domain health changed");
    }
  }
}
