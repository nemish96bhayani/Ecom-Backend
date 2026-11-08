import { Types } from "mongoose";
import { env } from "../config/env.js";
import { runAsTenant, runWithoutTenant } from "../db/tenantContext.js";
import { Commission, Statement } from "../models/billing.js";
import { Tenant, PlatformCounter } from "../models/platform.js";
import { Order } from "../models/orders.js";
import { splitGst } from "./pricing.js";
import { financialYear } from "./fy.js";
import { renderTaxInvoice, renderShippingLabel } from "./pdf.js";
import { logger } from "../lib/logger.js";

export function previousPeriod(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodRange(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  // Month boundaries in IST (UTC+5:30)
  const start = new Date(Date.UTC(y, m - 1, 1) - 330 * 60_000);
  const end = new Date(Date.UTC(y, m, 1) - 330 * 60_000);
  return { start, end };
}

async function nextPlatformInvoiceNumber(date: Date) {
  const fy = financialYear(date);
  const c = await PlatformCounter.findOneAndUpdate({ key: `commission-invoice:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `COM/${fy}/${String(c!.seq).padStart(5, "0")}`;
}

/** Builds the monthly commission statement + GST invoice for one tenant. Idempotent per period. */
export async function generateStatement(tenantId: string, period: string) {
  const tenant = await runWithoutTenant("statement", () => Tenant.findById(tenantId).lean());
  if (!tenant) return null;
  return runAsTenant(tenantId, async () => {
    const existing = await Statement.findOne({ period });
    if (existing) return existing;
    const { start, end } = periodRange(period);
    const commissions = await Commission.find({ status: "accrued", statementId: null, accruedAt: { $gte: start, $lt: end } }).lean();
    const commissionPaise = commissions.reduce((s, c) => s + (c.amountPaise ?? 0), 0);
    const gmvPaise = commissions.reduce((s, c) => s + (c.basePaise ?? 0), 0);
    const monthlyFeePaise = tenant.plan?.monthlyFeePaise ?? 0;
    const taxable = commissionPaise + monthlyFeePaise;
    if (taxable === 0) return null;
    const tax = Math.round((taxable * env.COMMISSION_GST_PERCENT) / 100);
    const gst = splitGst(tax, env.PLATFORM_STATE_CODE, tenant.business?.stateCode ?? undefined);
    const now = new Date();
    const statement = await Statement.create({
      period,
      invoiceNumber: await nextPlatformInvoiceNumber(now),
      orderCount: commissions.length,
      gmvPaise,
      commissionPaise,
      monthlyFeePaise,
      taxablePaise: taxable,
      ...gst,
      totalPaise: taxable + tax,
      status: "due",
      dueDate: new Date(now.getTime() + (tenant.billing?.graceDays ?? 10) * 86_400_000),
    });
    await Commission.updateMany({ _id: { $in: commissions.map((c) => c._id) } }, { $set: { status: "billed", statementId: statement._id } });
    logger.info({ tenantId, period, total: statement.totalPaise }, "Commission statement generated");
    return statement;
  });
}

export async function generateAllStatements(period = previousPeriod()) {
  const tenants = await runWithoutTenant("monthly-billing", () => Tenant.find({ status: { $ne: "pending" } }).select("_id").lean());
  for (const t of tenants) {
    try {
      await generateStatement(String(t._id), period);
    } catch (err) {
      logger.error({ err, tenantId: t._id, period }, "Statement generation failed");
    }
  }
}

export async function statementPdf(tenantId: string, statementId: string) {
  const tenant = await runWithoutTenant("statement-pdf", () => Tenant.findById(tenantId).lean());
  return runAsTenant(tenantId, async () => {
    const s = await Statement.findById(statementId).lean();
    if (!s || !tenant) return null;
    const rows = [
      { description: `Platform commission (${s.orderCount} orders, ${s.period})`, hsn: "998599", taxable: s.commissionPaise ?? 0, taxRate: env.COMMISSION_GST_PERCENT, tax: 0, total: 0 },
    ];
    if (s.monthlyFeePaise) rows.push({ description: "Monthly platform fee", hsn: "998599", taxable: s.monthlyFeePaise, taxRate: env.COMMISSION_GST_PERCENT, tax: 0, total: 0 });
    for (const r of rows) {
      r.tax = Math.round((r.taxable * env.COMMISSION_GST_PERCENT) / 100);
      r.total = r.taxable + r.tax;
    }
    return renderTaxInvoice({
      title: "Tax Invoice",
      invoiceNumber: s.invoiceNumber,
      date: s.createdAt as Date,
      seller: { name: env.PLATFORM_LEGAL_NAME, address: env.PLATFORM_ADDRESS, gstin: env.PLATFORM_GSTIN, stateCode: env.PLATFORM_STATE_CODE },
      buyer: { name: tenant.business?.legalName ?? tenant.name, address: tenant.business?.address ?? undefined, gstin: tenant.business?.gstin ?? undefined, stateCode: tenant.business?.stateCode ?? undefined },
      rows,
      totals: { taxable: s.taxablePaise ?? 0, cgst: s.cgstPaise ?? 0, sgst: s.sgstPaise ?? 0, igst: s.igstPaise ?? 0, total: s.totalPaise ?? 0 },
      notes: [`Due by ${s.dueDate?.toLocaleDateString("en-IN")}. Collected by auto-debit where a mandate is active.`],
    });
  });
}

/** Customer tax invoice issued in the merchant's name. Assigns an invoice number on first request. */
export async function orderInvoicePdf(tenantId: string, orderId: string) {
  const tenant = await runWithoutTenant("order-invoice", () => Tenant.findById(tenantId).lean());
  return runAsTenant(tenantId, async () => {
    const order = await Order.findById(orderId);
    if (!order || !tenant) return null;
    if (!order.invoice?.number) {
      const { nextSeq } = await import("../models/orders.js");
      const fy = financialYear(order.createdAt as Date);
      const seq = await nextSeq(`invoice:${fy}`, 0);
      order.invoice = { number: `INV/${fy}/${String(seq).padStart(5, "0")}`, issuedAt: new Date() };
      await order.save();
    }
    const t = order.totals!;
    const rows = order.items.map((i) => ({
      description: `${i.title}${i.variantLabel ? ` (${i.variantLabel})` : ""}`,
      hsn: i.hsn ?? undefined,
      qty: i.quantity ?? 1,
      taxable: i.taxablePaise ?? 0,
      taxRate: i.gstRatePercent ?? 0,
      tax: i.taxPaise ?? 0,
      total: (i.taxablePaise ?? 0) + (i.taxPaise ?? 0),
    }));
    const extras = (t.shippingPaise ?? 0) + (t.codFeePaise ?? 0);
    if (extras) {
      const taxable = Math.round((extras * 100) / 118);
      rows.push({ description: "Shipping & handling", hsn: "996812", qty: 1, taxable, taxRate: 18, tax: extras - taxable, total: extras });
    }
    const taxable = rows.reduce((s, r) => s + r.taxable, 0);
    const a = order.shippingAddress!;
    return renderTaxInvoice({
      title: "Tax Invoice",
      invoiceNumber: order.invoice!.number!,
      date: order.invoice!.issuedAt ?? new Date(),
      seller: { name: tenant.business?.legalName ?? tenant.name, address: tenant.business?.address ?? undefined, gstin: tenant.business?.gstin ?? undefined, stateCode: tenant.business?.stateCode ?? undefined, email: tenant.business?.email ?? undefined },
      buyer: { name: a.name ?? "", address: [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(", "), stateCode: a.stateCode ?? undefined, phone: a.phone ?? undefined },
      rows,
      totals: { taxable, cgst: t.cgstPaise ?? 0, sgst: t.sgstPaise ?? 0, igst: t.igstPaise ?? 0, total: t.totalPaise ?? 0 },
      notes: [`Order ${order.number}. Payment: ${order.payment?.method === "cod" ? "Cash on delivery" : "Online"}.`, "This is a computer-generated invoice."],
    });
  });
}

/** Courier shipping label PDF for merchant or logistics fulfillment. */
export async function orderShippingLabelPdf(tenantId: string, orderId: string) {
  const tenant = await runWithoutTenant("order-shipping-label", () => Tenant.findById(tenantId).lean());
  return runAsTenant(tenantId, async () => {
    const order = await Order.findById(orderId);
    if (!order || !tenant) return null;
    const a = order.shippingAddress!;
    const origin = (tenant.settings?.shippingOrigin as any) ?? {};
    const courier = order.shipment?.courier || (order.shipment?.provider === "shiprocket" ? "Shiprocket Express" : "Express Courier (Sandbox)");
    const awb = order.shipment?.awb || `MOCK${order.number.replace(/\D/g, "")}`;
    return renderShippingLabel({
      courier,
      awb,
      orderNumber: order.number,
      orderDate: (order.createdAt as Date) ?? new Date(),
      paymentMethod: (order.payment?.method as any) === "cod" ? "cod" : "online",
      totalPaise: order.totals?.totalPaise ?? 0,
      shipper: {
        name: tenant.business?.legalName ?? tenant.name,
        address: origin.address || tenant.business?.address || undefined,
        city: origin.city || undefined,
        state: origin.state || undefined,
        pincode: origin.pincode || undefined,
        phone: tenant.business?.phone ?? undefined,
        gstin: tenant.business?.gstin ?? undefined,
      },
      recipient: {
        name: a.name ?? "Customer",
        line1: a.line1 ?? "",
        line2: a.line2 ?? undefined,
        city: a.city ?? "",
        state: a.state ?? "",
        pincode: a.pincode ?? "",
        phone: a.phone ?? "",
      },
      weightKg: order.items.reduce((s, i) => s + (i.weightKg ?? origin.defaultWeightKg ?? 0.5) * (i.quantity ?? 1), 0),
      dims: origin.dims ?? { l: 20, b: 15, h: 5 },
      items: order.items.map((i) => ({ title: i.title ?? "Item", sku: i.sku ?? undefined, quantity: i.quantity ?? 1 })),
    });
  });
}

export const asObjectId = (id: string) => new Types.ObjectId(id);
