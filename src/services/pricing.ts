import { Types } from "mongoose";
import { Product, Coupon } from "../models/catalog.js";
import { badRequest } from "../lib/errors.js";

export const SHIPPING_GST_PERCENT = 18;

/** Prices are GST-inclusive (MRP style). Splits a line into taxable value + tax. */
export function splitInclusive(amountPaise: number, ratePercent: number) {
  const taxable = Math.round((amountPaise * 100) / (100 + ratePercent));
  return { taxablePaise: taxable, taxPaise: amountPaise - taxable };
}

/** Intra-state supply → CGST + SGST; inter-state → IGST. */
export function splitGst(taxPaise: number, sellerStateCode: string, buyerStateCode?: string) {
  if (buyerStateCode && buyerStateCode === sellerStateCode) {
    const cgst = Math.floor(taxPaise / 2);
    return { cgstPaise: cgst, sgstPaise: taxPaise - cgst, igstPaise: 0 };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
}

export type CouponLike = { type: "percent" | "flat"; value: number; minOrderPaise?: number | null; maxDiscountPaise?: number | null };

export function couponDiscount(c: CouponLike, subtotalPaise: number) {
  if (subtotalPaise < (c.minOrderPaise ?? 0)) return 0;
  let d = c.type === "percent" ? Math.round((subtotalPaise * c.value) / 100) : c.value;
  if (c.maxDiscountPaise) d = Math.min(d, c.maxDiscountPaise);
  return Math.min(d, subtotalPaise);
}

export type QuoteItemInput = { productId: string; variantId: string; quantity: number };
export type CheckoutSettings = {
  codEnabled: boolean;
  codMaxPaise: number;
  prepaidDiscountPaise: number;
  freeShippingAbovePaise: number;
  flatShippingPaise: number;
  codFeePaise: number;
};

export async function buildQuote(opts: {
  items: QuoteItemInput[];
  couponCode?: string;
  paymentMethod?: "online" | "cod";
  sellerStateCode: string;
  buyerStateCode?: string;
  settings: CheckoutSettings;
}) {
  if (!opts.items.length) throw badRequest("Your cart is empty");
  const ids = [...new Set(opts.items.map((i) => i.productId))].map((id) => new Types.ObjectId(id));
  const products = await Product.find({ _id: { $in: ids }, status: "active" }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const problems: { variantId: string; message: string }[] = [];

  const lines = opts.items.flatMap((i) => {
    const p = byId.get(i.productId);
    const v = p?.variants.find((x: any) => String(x._id) === i.variantId);
    if (!p || !v) {
      problems.push({ variantId: i.variantId, message: "This item is no longer available" });
      return [];
    }
    if (v.stock < i.quantity) problems.push({ variantId: i.variantId, message: v.stock === 0 ? "Out of stock" : `Only ${v.stock} left` });
    const options = v.options instanceof Map ? Object.fromEntries(v.options) : (v.options ?? {});
    return [{
      productId: p._id,
      variantId: v._id,
      title: p.title,
      variantLabel: Object.values(options).join(" / "),
      sku: v.sku,
      hsn: p.hsn,
      imageUrl: v.imageUrl ?? p.images?.[0]?.url,
      quantity: i.quantity,
      unitPricePaise: v.pricePaise,
      gstRatePercent: p.gstRatePercent ?? 0,
      lineTotalPaise: v.pricePaise * i.quantity,
      weightKg: v.weightKg ?? undefined,
      slug: p.slug,
    }];
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotalPaise, 0);

  let discount = 0;
  let couponCode: string | undefined;
  let couponMessage: string | undefined;
  if (opts.couponCode) {
    const now = new Date();
    const c = await Coupon.findOne({ code: opts.couponCode.toUpperCase(), isActive: true }).lean();
    if (!c || (c.startsAt && c.startsAt > now) || (c.endsAt && c.endsAt < now) || (c.usageLimit && c.usedCount >= c.usageLimit)) {
      couponMessage = "This coupon isn't valid";
    } else {
      discount = couponDiscount(c as CouponLike, subtotal);
      if (discount === 0) couponMessage = `Add items worth ₹${((c.minOrderPaise ?? 0) / 100).toFixed(0)} to use this coupon`;
      else couponCode = c.code;
    }
  }
  const s = opts.settings;
  if (opts.paymentMethod === "online" && s.prepaidDiscountPaise > 0) discount += Math.min(s.prepaidDiscountPaise, subtotal - discount);

  const afterDiscount = subtotal - discount;
  const shipping = afterDiscount >= s.freeShippingAbovePaise ? 0 : s.flatShippingPaise;
  const codFee = opts.paymentMethod === "cod" ? s.codFeePaise : 0;
  const total = afterDiscount + shipping + codFee;

  // Tax: discount is spread across lines in proportion to their value.
  let taxTotal = 0;
  const taxedLines = lines.map((l) => {
    const share = subtotal ? Math.round((l.lineTotalPaise / subtotal) * discount) : 0;
    const { taxablePaise, taxPaise } = splitInclusive(l.lineTotalPaise - share, l.gstRatePercent);
    taxTotal += taxPaise;
    return { ...l, taxablePaise, taxPaise };
  });
  const extras = splitInclusive(shipping + codFee, SHIPPING_GST_PERCENT);
  taxTotal += extras.taxPaise;

  const codAllowed = s.codEnabled && total <= s.codMaxPaise;
  return {
    lines: taxedLines,
    problems,
    couponCode,
    couponMessage,
    codAllowed,
    totals: {
      subtotalPaise: subtotal,
      discountPaise: discount,
      shippingPaise: shipping,
      codFeePaise: codFee,
      totalPaise: total,
      taxPaise: taxTotal,
      ...splitGst(taxTotal, opts.sellerStateCode, opts.buyerStateCode),
    },
  };
}
