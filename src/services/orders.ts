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
    if (quote.couponCode) {
      // Increment only while under the limit, so two simultaneous checkouts can't both use the last redemption.
      const r = await Coupon.updateOne(
        { code: quote.couponCode, $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] },
        { $inc: { usedCount: 1 } },
        { session },
      );
      if (r.modifiedCount !== 1) throw conflict("This coupon has just been fully used");
    }

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

/** Hands back a coupon redemption once (guarded by couponReleased) when an order that never got confirmed fails or is cancelled. */
async function releaseCoupon(orderId: Types.ObjectId) {
  const o = await Order.findOneAndUpdate({ _id: orderId, couponCode: { $nin: [null, ""] }, couponReleased: { $ne: true } }, { $set: { couponReleased: true } }, { new: true });
  if (o?.couponCode) await Coupon.updateOne({ code: o.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

/** A released order that gets confirmed after all (late payment) counts against the coupon again. */
async function reclaimCoupon(orderId: Types.ObjectId) {
  const o = await Order.findOneAndUpdate({ _id: orderId, couponReleased: true }, { $set: { couponReleased: false } }, { new: true });
  if (o?.couponCode) await Coupon.updateOne({ code: o.couponCode }, { $inc: { usedCount: 1 } });
}

const changedUnderneath = () => conflict("This order was changed by someone else just now. Reload it and try again.");

/** Single place where order status changes – keeps commission, stock and notifications consistent. */
export async function transitionOrder(orderId: string, to: OrderStatus, opts: { note?: string; by: string; force?: boolean } = { by: "system" }) {
  const tenantId = requireTenantId();
  const order = await Order.findById(orderId);
  if (!order) throw new AppError(404, "not_found", "Order not found");
  const from = order.status as OrderStatus;
  if (from === to) return order;
  if (!opts.force && !canTransition(from, to)) throw badRequest(`An order that is ${from.replace("_", " ")} can't be marked ${to.replace("_", " ")}`);
  if (!opts.force && to === "cancelled" && order.shipment?.awb) {
    throw conflict(`A courier shipment (AWB ${order.shipment.awb}) is booked for this order. Cancel the shipment first, then cancel the order.`);
  }

  // Conditional on the status we validated against, so two racing changes can't both apply.
  const update: Record<string, unknown> = {
    $set: { status: to },
    $push: { statusHistory: { status: to, note: opts.note, by: opts.by, at: new Date() } },
  };
  if (to === "confirmed") update.$unset = { expiresAt: 1 };
  const updated = await Order.findOneAndUpdate({ _id: order._id, status: from }, update, { new: true });
  if (!updated) {
    const now = await Order.findById(order._id);
    // The same change was just applied by a concurrent call (e.g. webhook + return URL); its side effects ran there.
    if (now?.status === to) return now;
    throw changedUnderneath();
  }
  const wasConfirmed = order.statusHistory.some((h) => h.status === "confirmed");

  if (to === "confirmed") {
    const tenant = await Tenant.findById(tenantId).select("plan").lean();
    await accrueCommission(updated, tenant?.plan?.commissionRatePercent ?? 3);
    await Customer.updateOne({ _id: updated.customerId }, { $inc: { orderCount: 1 }, $set: { lastOrderAt: new Date() } });
    if (updated.couponReleased) await reclaimCoupon(updated._id);
    await enqueueNotification({ type: "order_placed", tenantId, orderId });
    if (updated.payment?.method === "online") await enqueueNotification({ type: "meta_purchase", tenantId, orderId });
  }
  if (["cancelled", "payment_failed", "rto", "returned"].includes(to)) {
    await releaseStock(updated._id);
    await reverseCommission(updated._id, to);
  }
  if ((to === "cancelled" || to === "payment_failed") && !wasConfirmed && updated.couponCode) await releaseCoupon(updated._id);
  if (["packed", "shipped", "delivered", "cancelled", "rto", "refunded"].includes(to)) {
    await enqueueNotification({ type: "order_status", tenantId, orderId, status: to });
  }
  return updated;
}

const SETTLED_PAYMENT = ["paid", "refunded", "partially_refunded"];

/** Called from webhooks and the return-URL status check. Safe to call many times. */
export async function markOrderPaid(orderId: string, paymentId?: string, amountPaise?: number) {
  const order = await Order.findById(orderId);
  if (!order || SETTLED_PAYMENT.includes(order.payment?.status ?? "")) return order;
  const due = order.totals?.totalPaise ?? 0;
  if (amountPaise !== undefined && amountPaise < due) {
    // Underpaid: leave it unconfirmed and flag it for the merchant instead of shipping goods.
    order.notes = `${order.notes ?? ""}\nGateway reported ${amountPaise} paise against ${due} due – check before confirming.`.trim();
    await order.save();
    return order;
  }
  // Only one caller (webhook vs return URL) gets to flip the payment to paid.
  const set: Record<string, unknown> = { "payment.status": "paid", "payment.paidAt": new Date() };
  if (paymentId) set["payment.providerPaymentId"] = paymentId;
  const notYetPaid: Record<string, unknown> = { _id: order._id, "payment.status": { $nin: SETTLED_PAYMENT } };
  const paid = await Order.findOneAndUpdate(notYetPaid, { $set: set }, { new: true });
  if (!paid) return Order.findById(orderId);
  if (paid.stockReleased) {
    // Payment arrived after the reservation expired – re-reserve if possible, otherwise flag for manual review.
    const notes = `${paid.notes ?? ""}\nPaid after reservation expired – check stock before shipping.`.trim();
    await Order.updateOne({ _id: paid._id }, { $set: { notes } });
  }
  return transitionOrder(orderId, "confirmed", { by: "payment", note: "Payment received", force: paid.status === "payment_failed" });
}

/** COD money only exists once the courier collected it (delivered, or explicitly marked collected). */
const codWasCollected = (order: { status?: string | null; payment?: { status?: string | null } | null; statusHistory?: { status?: string | null }[] }) =>
  ["cod_collected", "partially_refunded"].includes(order.payment?.status ?? "") ||
  ["delivered", "returned"].includes(order.status ?? "") ||
  (order.statusHistory ?? []).some((h) => h.status === "delivered");

export async function refundOrder(orderId: string, amountPaise: number | undefined, reason: string, by: string) {
  const tenantId = requireTenantId();
  const order = await Order.findById(orderId);
  if (!order) throw new AppError(404, "not_found", "Order not found");
  const total = order.totals?.totalPaise ?? 0;
  const refunds = order.payment?.refunds ?? [];
  const already = refunds.reduce((s, r) => s + (r.amountPaise ?? 0), 0);
  const amount = amountPaise ?? total - already;
  if (amount <= 0 || already + amount > total) throw badRequest("Refund amount is more than what was paid");

  const online = order.payment?.method === "online";
  if (online) {
    if (order.payment!.status !== "paid" && order.payment!.status !== "partially_refunded") throw badRequest("This order hasn't been paid online");
  } else if (!codWasCollected(order)) {
    throw badRequest("This cash-on-delivery order hasn't been paid yet. Cancel it instead of refunding.");
  }

  // Reserve the refund first, conditional on the refund count we read, so two parallel refunds can't exceed the amount paid.
  const n = refunds.length;
  const refundId = online ? `rf_${order.number}_${n + 1}` : `manual_${Date.now()}`;
  const sizeFilter = n === 0 ? { $or: [{ "payment.refunds": { $size: 0 } }, { "payment.refunds": { $exists: false } }] } : { "payment.refunds": { $size: n } };
  const reserved = await Order.findOneAndUpdate(
    { _id: order._id, ...sizeFilter },
    { $push: { "payment.refunds": { refundId, amountPaise: amount, status: online ? "pending" : "recorded", at: new Date(), reason } } },
    { new: true },
  );
  if (!reserved) throw conflict("Another refund for this order was just recorded. Reload the order and check the amount before trying again.");

  const fully = already + amount >= total;
  const set: Record<string, unknown> = { "payment.status": fully ? "refunded" : "partially_refunded" };
  if (online) {
    let r;
    try {
      const provider = await getPaymentProvider(tenantId);
      r = await provider.refund({ providerOrderId: order.payment!.providerOrderId!, paymentId: order.payment!.providerPaymentId ?? undefined, amountPaise: amount, refundId, reason });
    } catch (err) {
      await Order.updateOne({ _id: order._id }, { $pull: { "payment.refunds": { refundId } } });
      throw err;
    }
    set["payment.refunds.$[r].refundId"] = r.refundId;
    set["payment.refunds.$[r].status"] = r.status;
  }
  const updated = (await Order.findOneAndUpdate({ _id: order._id }, { $set: set }, { new: true, ...(online ? { arrayFilters: [{ "r.refundId": refundId }] } : {}) }))!;

  const merchandiseShare = Math.min(amount, Math.max(0, (order.totals?.subtotalPaise ?? 0) - (order.totals?.discountPaise ?? 0)));
  if (fully) {
    await reverseCommission(order._id, "refunded");
    if (canTransition(updated.status as OrderStatus, "refunded")) await transitionOrder(orderId, "refunded", { by, note: reason });
  } else {
    await adjustCommissionForRefund(order._id, merchandiseShare);
  }
  return updated;
}
