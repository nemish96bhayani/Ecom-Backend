import { Types } from "mongoose";
import { withTransaction } from "../db/connect.js";
import { requireTenantId } from "../db/tenantContext.js";
import { Product, Coupon } from "../models/catalog.js";
import { Order, nextSeq, type OrderStatus } from "../models/orders.js";
import { Customer } from "../models/people.js";
import { Tenant } from "../models/platform.js";
import { AppError, badRequest, conflict } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { buildQuote, type QuoteItemInput } from "./pricing.js";
import { accrueCommission, reverseCommission, adjustCommissionForRefund } from "./commission.js";
import { enqueueNotification } from "../jobs/queues.js";
import { getPaymentProvider } from "../integrations/payments/index.js";

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["confirmed", "payment_failed", "cancelled"],
  payment_failed: ["confirmed", "cancelled"],
  pending_confirmation: ["confirmed", "cancelled"],
  confirmed: ["packed", "shipped", "cancelled", "refunded"],
  packed: ["shipped", "cancelled", "refunded"],
  shipped: ["delivered", "rto"],
  delivered: ["returned", "refunded"],
  rto: ["refunded"],
  returned: ["refunded"],
  cancelled: ["refunded"],
  refunded: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => TRANSITIONS[from]?.includes(to) ?? false;

const PENDING_PAYMENT_TTL_MIN = 30;

export type AddressInput = { name: string; phone: string; line1: string; line2?: string; city: string; state: string; stateCode: string; pincode: string };

export async function loadStoreTenant(tenantId: string) {
  const t = await Tenant.findById(tenantId).lean();
  if (!t) throw new AppError(404, "store_not_found", "Store not found");
  return t;
}

/** Creates an order and reserves stock atomically (MongoDB transaction). */
export async function placeOrder(input: {
  customerId: string;
  items: QuoteItemInput[];
  address: AddressInput;
  email?: string;
  paymentMethod: "online" | "cod";
  couponCode?: string;
  utm?: Record<string, string | undefined>;
  notes?: string;
}) {
  const tenantId = requireTenantId();
  const tenant = await loadStoreTenant(tenantId);
  const settings = tenant.settings!.checkout as any;
  const quote = await buildQuote({
    items: input.items,
    couponCode: input.couponCode,
    paymentMethod: input.paymentMethod,
    sellerStateCode: tenant.business?.stateCode ?? "24",
    buyerStateCode: input.address.stateCode,
    settings,
  });
  if (quote.problems.length) throw new AppError(409, "cart_problems", "Some items in your cart changed", quote.problems);
  if (input.paymentMethod === "cod" && !quote.codAllowed) throw badRequest("Cash on delivery isn't available for this order");

  const order = await withTransaction(async (session) => {
    for (const l of quote.lines) {
      const r = await Product.updateOne(
        { _id: l.productId, variants: { $elemMatch: { _id: l.variantId, stock: { $gte: l.quantity } } } },
        { $inc: { "variants.$.stock": -l.quantity } },
        { session },
      );
      if (r.modifiedCount !== 1) throw conflict(`${l.title} just went out of stock`);
    }
    if (quote.couponCode) await Coupon.updateOne({ code: quote.couponCode }, { $inc: { usedCount: 1 } }, { session });

    const seq = await nextSeq("order");
    const prefix = (tenant.slug ?? "ST").slice(0, 3).toUpperCase();
    const isCod = input.paymentMethod === "cod";
    const status: OrderStatus = isCod ? "pending_confirmation" : "pending_payment";
    const customer = await Customer.findById(input.customerId).session(session);
    const [doc] = await Order.create(
      [
        {
          number: `${prefix}-${seq}`,
          customerId: new Types.ObjectId(input.customerId),
          customer: { name: input.address.name, phone: input.address.phone, email: input.email ?? customer?.email },
          shippingAddress: input.address,
          items: quote.lines,
          totals: quote.totals,
          couponCode: quote.couponCode,
          status,
          statusHistory: [{ status, note: "Order placed", by: "customer" }],
          payment: { method: input.paymentMethod, status: isCod ? "cod_pending" : "pending" },
          codConfirmToken: isCod ? randomToken(18) : undefined,
          utm: input.utm,
          notes: input.notes,
          expiresAt: isCod ? undefined : new Date(Date.now() + PENDING_PAYMENT_TTL_MIN * 60_000),
        },
      ],
      { session },
    );
    if (customer) {
      if (input.email && !customer.email) customer.email = input.email;
      if (!customer.name) customer.name = input.address.name;
      await customer.save({ session });
    }
    return doc!;
  });
  return { order, quote };
}

export async function releaseStock(orderId: Types.ObjectId | string) {
  await withTransaction(async (session) => {
    const order = await Order.findOneAndUpdate({ _id: orderId, stockReleased: false }, { $set: { stockReleased: true } }, { session, new: true });
    if (!order) return;
    for (const it of order.items) {
      await Product.updateOne({ _id: it.productId, "variants._id": it.variantId }, { $inc: { "variants.$.stock": it.quantity ?? 0 } }, { session });
    }
  });
}

/** Single place where order status changes – keeps commission, stock and notifications consistent. */
export async function transitionOrder(orderId: string, to: OrderStatus, opts: { note?: string; by: string; force?: boolean } = { by: "system" }) {
  const tenantId = requireTenantId();
  const order = await Order.findById(orderId);
  if (!order) throw new AppError(404, "not_found", "Order not found");
  const from = order.status as OrderStatus;
  if (from === to) return order;
  if (!opts.force && !canTransition(from, to)) throw badRequest(`An order that is ${from.replace("_", " ")} can't be marked ${to.replace("_", " ")}`);

  order.status = to;
  order.statusHistory.push({ status: to, note: opts.note, by: opts.by, at: new Date() });
  if (to === "confirmed") order.expiresAt = undefined;
  await order.save();

  if (to === "confirmed") {
    const tenant = await Tenant.findById(tenantId).select("plan").lean();
    await accrueCommission(order, tenant?.plan?.commissionRatePercent ?? 3);
    await Customer.updateOne({ _id: order.customerId }, { $inc: { orderCount: 1 }, $set: { lastOrderAt: new Date() } });
    await enqueueNotification({ type: "order_placed", tenantId, orderId });
    if (order.payment?.method === "online") await enqueueNotification({ type: "meta_purchase", tenantId, orderId });
  }
  if (["cancelled", "payment_failed", "rto", "returned"].includes(to)) {
    await releaseStock(order._id);
    await reverseCommission(order._id, to);
  }
  if (["packed", "shipped", "delivered", "cancelled", "rto", "refunded"].includes(to)) {
    await enqueueNotification({ type: "order_status", tenantId, orderId, status: to });
  }
  return order;
}

/** Called from webhooks and the return-URL status check. Safe to call many times. */
export async function markOrderPaid(orderId: string, paymentId?: string) {
  const order = await Order.findById(orderId);
  if (!order || order.payment?.status === "paid") return order;
  order.payment!.status = "paid";
  order.payment!.paidAt = new Date();
  if (paymentId) order.payment!.providerPaymentId = paymentId;
  await order.save();
  if (order.stockReleased) {
    // Payment arrived after the reservation expired – re-reserve if possible, otherwise flag for manual review.
    order.notes = `${order.notes ?? ""}\nPaid after reservation expired – check stock before shipping.`.trim();
    await order.save();
  }
  return transitionOrder(orderId, "confirmed", { by: "payment", note: "Payment received", force: order.status === "payment_failed" });
}

export async function refundOrder(orderId: string, amountPaise: number | undefined, reason: string, by: string) {
  const tenantId = requireTenantId();
  const order = await Order.findById(orderId);
  if (!order) throw new AppError(404, "not_found", "Order not found");
  const total = order.totals?.totalPaise ?? 0;
  const already = (order.payment?.refunds ?? []).reduce((s, r) => s + (r.amountPaise ?? 0), 0);
  const amount = amountPaise ?? total - already;
  if (amount <= 0 || already + amount > total) throw badRequest("Refund amount is more than what was paid");

  if (order.payment?.method === "online") {
    if (order.payment.status !== "paid" && order.payment.status !== "partially_refunded") throw badRequest("This order hasn't been paid online");
    const provider = await getPaymentProvider(tenantId);
    const refundId = `rf_${order.number}_${(order.payment.refunds?.length ?? 0) + 1}`;
    const r = await provider.refund({ providerOrderId: order.payment.providerOrderId!, paymentId: order.payment.providerPaymentId ?? undefined, amountPaise: amount, refundId, reason });
    order.payment.refunds.push({ refundId: r.refundId, amountPaise: amount, status: r.status, at: new Date(), reason });
  } else {
    // COD: money goes back by bank transfer/UPI outside the platform; we record it.
    order.payment!.refunds.push({ refundId: `manual_${Date.now()}`, amountPaise: amount, status: "recorded", at: new Date(), reason });
  }
  const fully = already + amount >= total;
  order.payment!.status = fully ? "refunded" : "partially_refunded";
  await order.save();

  const merchandiseShare = Math.min(amount, Math.max(0, (order.totals?.subtotalPaise ?? 0) - (order.totals?.discountPaise ?? 0)));
  if (fully) {
    await reverseCommission(order._id, "refunded");
    if (canTransition(order.status as OrderStatus, "refunded")) await transitionOrder(orderId, "refunded", { by, note: reason });
  } else {
    await adjustCommissionForRefund(order._id, merchandiseShare);
  }
  return order;
}
