import { Types } from "mongoose";
import { Commission } from "../models/billing.js";

/** Commission base = merchandise value after discounts (excludes shipping & COD fee). */
export const commissionBase = (t: { subtotalPaise: number; discountPaise: number }) => Math.max(0, t.subtotalPaise - t.discountPaise);
export const commissionAmount = (basePaise: number, ratePercent: number) => Math.round((basePaise * ratePercent) / 100);

export async function accrueCommission(order: { _id: any; number: string; totals?: any }, ratePercent: number) {
  const base = commissionBase(order.totals);
  await Commission.updateOne(
    { orderId: order._id },
    { $setOnInsert: { orderId: order._id, orderNumber: order.number, basePaise: base, ratePercent, amountPaise: commissionAmount(base, ratePercent), status: "accrued", accruedAt: new Date() } },
    { upsert: true },
  );
}

/** Cancelled / RTO / returned / fully refunded orders don't pay commission (see merchant agreement). */
export async function reverseCommission(orderId: Types.ObjectId | string, reason: string) {
  await Commission.updateOne({ orderId, status: "accrued" }, { $set: { status: "reversed", reversalReason: reason } });
}

/** Partial refund: reduce commission in proportion to the refunded merchandise value. */
export async function adjustCommissionForRefund(orderId: Types.ObjectId | string, refundedPaise: number) {
  const c = await Commission.findOne({ orderId, status: "accrued" });
  if (!c) return;
  const newBase = Math.max(0, (c.basePaise ?? 0) - refundedPaise);
  c.basePaise = newBase;
  c.amountPaise = commissionAmount(newBase, c.ratePercent ?? 0);
  if (newBase === 0) {
    c.status = "reversed";
    c.reversalReason = "refunded";
  }
  await c.save();
}
