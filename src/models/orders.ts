import { Schema, model } from "mongoose";
import { tenantPlugin, tenantIdField } from "../db/tenantPlugin.js";
import { addressSchema } from "./people.js";

export const ORDER_STATUSES = [
  "pending_payment", // online order created, waiting for gateway
  "pending_confirmation", // COD order waiting for customer confirmation
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
  "rto", // returned to origin (undelivered)
  "returned",
  "refunded",
  "payment_failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const orderItemSchema = new Schema(
  {
    productId: Schema.Types.ObjectId,
    variantId: Schema.Types.ObjectId,
    title: String,
    variantLabel: String,
    sku: String,
    hsn: String,
    imageUrl: String,
    quantity: Number,
    unitPricePaise: Number, // GST inclusive
    gstRatePercent: Number,
    lineTotalPaise: Number,
    taxablePaise: Number,
    taxPaise: Number,
    weightKg: Number,
  },
  { _id: true },
);

const orderSchema = new Schema(
  {
    tenantId: tenantIdField,
    number: { type: String, required: true }, // human friendly, e.g. ST-10023
    customerId: { type: Schema.Types.ObjectId, index: true },
    customer: { name: String, phone: String, email: String },
    shippingAddress: addressSchema,
    items: [orderItemSchema],
    totals: {
      subtotalPaise: Number,
      discountPaise: { type: Number, default: 0 },
      shippingPaise: { type: Number, default: 0 },
      codFeePaise: { type: Number, default: 0 },
      totalPaise: Number,
      taxPaise: Number,
      cgstPaise: { type: Number, default: 0 },
      sgstPaise: { type: Number, default: 0 },
      igstPaise: { type: Number, default: 0 },
    },
    couponCode: String,
    status: { type: String, enum: ORDER_STATUSES, required: true, index: true },
    statusHistory: [{ status: String, at: { type: Date, default: Date.now }, note: String, by: String }],
    payment: {
      method: { type: String, enum: ["online", "cod"], required: true },
      provider: String,
      providerOrderId: String,
      providerPaymentId: String,
      sessionId: String,
      status: { type: String, enum: ["pending", "paid", "failed", "refunded", "partially_refunded", "cod_pending", "cod_collected"], default: "pending" },
      settlementStatus: { type: String, enum: ["pending", "in_flight", "settled"], default: "pending" },
      settledAt: Date,
      utr: String,
      paidAt: Date,
      refunds: [{ refundId: String, amountPaise: Number, status: String, at: Date, reason: String }],
    },
    codConfirmToken: { type: String, select: false },
    shipment: {
      provider: String,
      providerOrderId: String,
      shipmentId: String,
      awb: String,
      courier: String,
      labelUrl: String,
      trackingUrl: String,
      status: String,
      currentStage: {
        type: String,
        enum: ["manifested", "in_transit", "out_for_delivery", "delivered", "ndr", "rto_initiated", "rto_delivered"],
      },
      ndrAttempts: { type: Number, default: 0 },
      lastNdrReason: String,
      expectedDeliveryDate: Date,
      dispatchedAt: Date,
      deliveredAt: Date,
      slaBreached: { type: Boolean, default: false },
      events: [{ status: String, location: String, at: Date }],
    },
    returnDetails: {
      type: { type: String, enum: ["customer_return", "courier_rto"] },
      reasonCategory: {
        type: String,
        enum: [
          "size_fit_issue",
          "quality_defect",
          "wrong_item_sent",
          "customer_refused_cod",
          "customer_unavailable",
          "incomplete_address",
          "delivery_delayed",
          "other",
        ],
      },
      subReason: String,
      status: {
        type: String,
        enum: [
          "initiated",
          "pickup_scheduled",
          "in_transit",
          "out_for_delivery_to_seller",
          "delivered_to_seller",
          "qc_passed",
          "qc_rejected_dispute",
        ],
      },
      initiatedAt: Date,
      deliveredToSellerAt: Date,
      returnAwb: String,
      courier: String,
      refundAmountPaise: Number,
      qcNotes: String,
    },
    invoice: { number: String, issuedAt: Date },
    utm: { source: String, medium: String, campaign: String, content: String, term: String, fbclid: String, gclid: String },
    notes: String,
    stockReleased: { type: Boolean, default: false },
    couponReleased: { type: Boolean, default: false }, // coupon redemption handed back after an unconfirmed order failed/cancelled
    shipmentLockAt: Date, // set while a courier booking is in progress, so a double click can't book two shipments
    expiresAt: Date, // for pending_payment orders – stock is released after this
  },
  { timestamps: true },
);
orderSchema.plugin(tenantPlugin);
orderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, "payment.providerOrderId": 1 });
orderSchema.index({ tenantId: 1, "shipment.awb": 1 });
orderSchema.index({ tenantId: 1, "returnDetails.type": 1, "returnDetails.status": 1 });
orderSchema.index({ tenantId: 1, "shipment.currentStage": 1 });
orderSchema.index({ tenantId: 1, "payment.settlementStatus": 1 });
orderSchema.index({ status: 1, expiresAt: 1 });
export const Order = model("Order", orderSchema);

/** Per-tenant counters for order and invoice numbers. */
const counterSchema = new Schema({
    tenantId: tenantIdField, key: { type: String, required: true }, seq: { type: Number, default: 0 } });
counterSchema.plugin(tenantPlugin);
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const Counter = model("Counter", counterSchema);

export async function nextSeq(key: string, start = 10000) {
  const doc = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return start + doc!.seq;
}
