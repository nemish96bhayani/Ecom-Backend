import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { moduleFor, escapeRegex } from "./_shared.js";
import { Category, Product, Page } from "../models/catalog.js";
import { Cart, Customer, OtpCode } from "../models/people.js";
import { Order } from "../models/orders.js";
import { Tenant } from "../models/platform.js";
import { pagination } from "../http/route.js";
import { notFound, badRequest, AppError } from "../lib/errors.js";
import { requireTenantId } from "../db/tenantContext.js";
import { signCustomer } from "../lib/jwt.js";
import { randomToken } from "../lib/crypto.js";
import { cached, redis } from "../lib/redis.js";
import { buildQuote } from "../services/pricing.js";
import { placeOrder, markOrderPaid, transitionOrder } from "../services/orders.js";
import { getPaymentProvider } from "../integrations/payments/index.js";
import { getShippingProvider } from "../integrations/shipping/index.js";
import { enqueueNotification } from "../jobs/queues.js";
import { orderInvoicePdf, orderShippingLabelPdf } from "../services/statements.js";
import { env, isProd } from "../config/env.js";

const { router, add } = moduleFor("Storefront", "/api/v1/store");
export default router;

const phone = z.string().transform((s) => s.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "")).pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"));
const PUBLIC_PRODUCT = "title slug description brand images optionNames variants._id variants.options variants.pricePaise variants.compareAtPaise variants.stock variants.imageUrl categoryIds isFeatured tags seo createdAt";

// ---------- Store config ----------
add({
  method: "get", path: "/config", summary: "Store name, theme and public settings", auth: "internal",
  handler: async ({ req }) => {
    const tenantId = requireTenantId();
    return cached(`store-config:${tenantId}`, 120, async () => {
      const t = await Tenant.findById(tenantId).lean();
      if (!t) throw notFound("Store");
      const pages = await Page.find({ isPublished: true }).select("title slug").lean();
      const s = t.settings!;
      return {
        id: t._id,
        name: t.name,
        primaryHost: req.store?.primaryHost,
        theme: s.theme,
        colors: s.colors,
        font: s.font,
        logoUrl: s.logoUrl,
        faviconUrl: s.faviconUrl,
        banners: s.banners,
        homeSections: s.homeSections,
        whatsappNumber: s.whatsappNumber,
        social: s.social,
        seo: s.seo,
        checkout: s.checkout,
        tracking: s.tracking,
        pages,
        business: { legalName: t.business?.legalName, address: t.business?.address, email: t.business?.email, phone: t.business?.phone, gstin: t.business?.gstin, grievanceOfficer: t.business?.grievanceOfficer },
      };
    });
  },
});

add({ method: "get", path: "/categories", summary: "Active categories", auth: "internal", handler: () => Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean() });

add({
  method: "get", path: "/products", summary: "Browse products", auth: "internal",
  query: pagination.extend({ q: z.string().optional(), category: z.string().optional(), featured: z.coerce.boolean().optional(), sort: z.enum(["new", "price_asc", "price_desc", "relevance"]).default("new") }),
  handler: async ({ query }) => {
    const f: any = { status: "active" };
    if (query.category) {
      const c = await Category.findOne({ slug: query.category }).lean();
      if (!c) return { items: [], total: 0, page: query.page, limit: query.limit };
      f.categoryIds = c._id;
    }
    if (query.featured) f.isFeatured = true;
    if (query.q) f.$or = [{ title: new RegExp(escapeRegex(query.q), "i") }, { tags: new RegExp(`^${escapeRegex(query.q)}`, "i") }];
    const sort: any = query.sort === "price_asc" ? { "variants.0.pricePaise": 1 } : query.sort === "price_desc" ? { "variants.0.pricePaise": -1 } : { createdAt: -1 };
    const [items, total] = await Promise.all([
      Product.find(f).select(PUBLIC_PRODUCT).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      Product.countDocuments(f),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  },
});

add({
  method: "get", path: "/products/:slug", summary: "Product details", auth: "internal", params: z.object({ slug: z.string() }),
  handler: async ({ params }) => {
    const isId = Types.ObjectId.isValid(params.slug);
    const filter: any = isId
      ? { $or: [{ _id: params.slug }, { slug: params.slug }], status: "active" }
      : { slug: params.slug, status: "active" };
    const p: any = await Product.findOne(filter).select(PUBLIC_PRODUCT).lean();
    if (!p) throw notFound("Product");
    const related = await Product.find({ status: "active", _id: { $ne: p._id }, categoryIds: { $in: p.categoryIds } }).select(PUBLIC_PRODUCT).limit(8).lean();
    return { product: p, related };
  },
});

add({
  method: "get", path: "/pages/:slug", summary: "Static page", auth: "internal", params: z.object({ slug: z.string() }),
  handler: async ({ params }) => (await Page.findOne({ slug: params.slug, isPublished: true }).lean()) ?? Promise.reject(notFound("Page")),
});

add({
  method: "get", path: "/sitemap", summary: "Data for sitemap.xml", auth: "internal",
  handler: async () => ({
    products: await Product.find({ status: "active" }).select("slug updatedAt").lean(),
    categories: await Category.find({ isActive: true }).select("slug updatedAt").lean(),
    pages: await Page.find({ isPublished: true }).select("slug updatedAt").lean(),
  }),
});

// ---------- Cart (server-side, keyed by a cart cookie) ----------
const CART_COOKIE = "cart_id";
async function getCart(req: any, res: any, create: boolean) {
  let token: string | undefined = req.cookies?.[CART_COOKIE];
  let cart = token ? await Cart.findOne({ token }) : null;
  if (!cart && create) {
    token = randomToken(18);
    cart = await Cart.create({ token, items: [], customerId: req.customer?.sub ?? null });
    res.cookie(CART_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 30 * 86_400_000, path: "/" });
  }
  return cart;
}

async function cartView(cart: any) {
  if (!cart || !cart.items.length) return { items: [], totals: null, problems: [] };
  const tenant = await Tenant.findById(requireTenantId()).lean();
  const q = await buildQuote({
    items: cart.items.map((i: any) => ({ productId: String(i.productId), variantId: String(i.variantId), quantity: i.quantity })),
    sellerStateCode: tenant?.business?.stateCode ?? "24",
    settings: tenant!.settings!.checkout as any,
  });
  return { items: q.lines, totals: q.totals, problems: q.problems };
}

add({ method: "get", path: "/cart", summary: "Current cart", auth: "customer-optional", handler: async ({ req, res }) => cartView(await getCart(req, res, false)) });

add({
  method: "post", path: "/cart/items", summary: "Add item to cart", auth: "customer-optional",
  body: z.object({ productId: z.string(), variantId: z.string(), quantity: z.number().int().min(1).max(50).default(1) }),
  handler: async ({ req, res, body }) => {
    const p = await Product.findOne({ _id: body.productId, status: "active", "variants._id": body.variantId }).lean();
    if (!p) throw notFound("Product");
    const cart = (await getCart(req, res, true))!;
    const existing = cart.items.find((i) => String(i.variantId) === body.variantId);
    if (existing) existing.quantity = Math.min(50, (existing.quantity ?? 0) + body.quantity);
    else cart.items.push({ productId: new Types.ObjectId(body.productId), variantId: new Types.ObjectId(body.variantId), quantity: body.quantity });
    await cart.save();
    return cartView(cart);
  },
});

add({
  method: "patch", path: "/cart/items/:variantId", summary: "Change quantity (0 removes)", auth: "customer-optional",
  params: z.object({ variantId: z.string() }), body: z.object({ quantity: z.number().int().min(0).max(50) }),
  handler: async ({ req, res, params, body }) => {
    const cart = await getCart(req, res, false);
    if (!cart) return cartView(null);
    const idx = cart.items.findIndex((i) => String(i.variantId) === params.variantId);
    if (idx >= 0) {
      if (body.quantity === 0) cart.items.splice(idx, 1);
      else cart.items[idx]!.quantity = body.quantity;
      await cart.save();
    }
    return cartView(cart);
  },
});

// ---------- Customer auth (mobile OTP) ----------
add({
  method: "post", path: "/auth/otp", summary: "Send a sign-in code by SMS/WhatsApp", auth: "internal",
  body: z.object({ phone }),
  handler: async ({ body }) => {
    const tenantId = requireTenantId();
    const rlKey = `otp-rl:${tenantId}:${body.phone}`;
    const sent = await redis.incr(rlKey).catch(() => 1);
    if (sent === 1) await redis.expire(rlKey, 600).catch(() => undefined);
    if (sent > 5) throw new AppError(429, "too_many_requests", "Too many codes requested. Try again in 10 minutes.");
    const code = String(crypto.randomInt(100000, 1000000));
    await OtpCode.deleteMany({ phone: body.phone });
    await OtpCode.create({ phone: body.phone, codeHash: await bcrypt.hash(code, 8), expiresAt: new Date(Date.now() + 5 * 60_000) });
    const t = await Tenant.findById(tenantId).select("name").lean();
    await enqueueNotification({ type: "otp", tenantId, phone: body.phone, code, storeName: t?.name ?? "" });
    return { sent: true, ...(env.NODE_ENV === "development" ? { devCode: code } : {}) };
  },
});

add({
  method: "post", path: "/auth/verify", summary: "Verify the code and sign in", auth: "internal",
  body: z.object({ phone, code: z.string().regex(/^\d{6}$/) }),
  handler: async ({ body, res, req }) => {
    const tenantId = requireTenantId();
    const otp = await OtpCode.findOne({ phone: body.phone, expiresAt: { $gt: new Date() } });
    if (!otp || otp.attempts >= 5) throw badRequest("The code expired. Request a new one.");
    if (!(await bcrypt.compare(body.code, otp.codeHash))) {
      otp.attempts += 1;
      await otp.save();
      throw badRequest("That code is incorrect");
    }
    await otp.deleteOne();
    const customer = await Customer.findOneAndUpdate({ phone: body.phone }, { $setOnInsert: { phone: body.phone } }, { upsert: true, new: true });
    const token = signCustomer({ sub: String(customer!._id), tenantId, kind: "customer" });
    res.cookie("cs_token", token, { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 30 * 86_400_000, path: "/" });
    const cartToken = req.cookies?.[CART_COOKIE];
    if (cartToken) await Cart.updateOne({ token: cartToken }, { $set: { customerId: customer!._id } });
    return { customer: { id: customer!._id, phone: customer!.phone, name: customer!.name, email: customer!.email } };
  },
});

add({
  method: "post", path: "/auth/logout", summary: "Sign out", auth: "internal",
  handler: ({ res }) => {
    res.clearCookie("cs_token", { path: "/" });
    return { ok: true };
  },
});

add({
  method: "get", path: "/me", summary: "Signed-in customer", auth: "customer",
  handler: async ({ req }) => (await Customer.findById(req.customer!.sub).lean()) ?? Promise.reject(notFound("Customer")),
});

const addressBody = z.object({
  name: z.string().min(2),
  phone,
  line1: z.string().min(3),
  line2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  stateCode: z.string().regex(/^\d{2}$/, "Select your state"),
  pincode: z.string().regex(/^\d{6}$/, "Enter a 6-digit pincode"),
});

add({
  method: "patch", path: "/me", summary: "Update profile and saved addresses", auth: "customer",
  body: z.object({ name: z.string().optional(), email: z.email().optional(), addresses: z.array(addressBody).max(10).optional(), marketingOptIn: z.boolean().optional() }),
  handler: async ({ req, body }) => Customer.findByIdAndUpdate(req.customer!.sub, { $set: body }, { new: true }).lean(),
});

// ---------- Checkout ----------
add({
  method: "post", path: "/checkout/quote", summary: "Price the cart with coupon, shipping and payment method", auth: "customer-optional",
  body: z.object({ couponCode: z.string().optional(), paymentMethod: z.enum(["online", "cod"]).default("online"), stateCode: z.string().optional() }),
  handler: async ({ req, res, body }) => {
    const cart = await getCart(req, res, false);
    if (!cart?.items.length) throw badRequest("Your cart is empty");
    const tenant = await Tenant.findById(requireTenantId()).lean();
    return buildQuote({
      items: cart.items.map((i) => ({ productId: String(i.productId), variantId: String(i.variantId), quantity: i.quantity! })),
      couponCode: body.couponCode,
      paymentMethod: body.paymentMethod,
      sellerStateCode: tenant?.business?.stateCode ?? "24",
      buyerStateCode: body.stateCode,
      settings: tenant!.settings!.checkout as any,
    });
  },
});

add({
  method: "post", path: "/checkout/serviceability", summary: "Check delivery to a pincode", auth: "internal",
  body: z.object({ pincode: z.string().regex(/^\d{6}$/), cod: z.boolean().default(false) }),
  handler: async ({ body }) => {
    const tenantId = requireTenantId();
    const t = await Tenant.findById(tenantId).lean();
    const origin = t?.settings?.shippingOrigin?.pincode;
    if (!origin) return { serviceable: true, couriers: [], note: "unchecked" };
    try {
      const r = await (await getShippingProvider(tenantId)).checkServiceability({ pickupPincode: origin, deliveryPincode: body.pincode, weightKg: 0.5, cod: body.cod });
      const fastest = r.couriers.reduce<number | undefined>((m, c) => (c.etaDays && (!m || c.etaDays < m) ? c.etaDays : m), undefined);
      return { serviceable: r.serviceable, codAvailable: r.couriers.some((c) => c.codAvailable), etaDays: fastest };
    } catch {
      return { serviceable: true, note: "unchecked" };
    }
  },
});

add({
  method: "post", path: "/checkout", summary: "Place the order", auth: "customer",
  body: z.object({
    address: addressBody,
    email: z.email().optional(),
    paymentMethod: z.enum(["online", "cod"]),
    couponCode: z.string().optional(),
    utm: z.object({ source: z.string(), medium: z.string(), campaign: z.string(), content: z.string(), term: z.string(), fbclid: z.string(), gclid: z.string() }).partial().optional(),
    notes: z.string().max(500).optional(),
    saveAddress: z.boolean().default(true),
  }),
  handler: async ({ req, res, body }) => {
    const tenantId = requireTenantId();
    const cart = await getCart(req, res, false);
    if (!cart?.items.length) throw badRequest("Your cart is empty");
    // Resolve the gateway BEFORE reserving stock, so a misconfigured store fails cleanly.
    const provider = body.paymentMethod === "online" ? await getPaymentProvider(tenantId) : null;
    const { order } = await placeOrder({
      customerId: req.customer!.sub,
      items: cart.items.map((i) => ({ productId: String(i.productId), variantId: String(i.variantId), quantity: i.quantity! })),
      address: body.address,
      email: body.email,
      paymentMethod: body.paymentMethod,
      couponCode: body.couponCode,
      utm: body.utm,
      notes: body.notes,
    });
    if (body.saveAddress) {
      await Customer.updateOne(
        { _id: req.customer!.sub, "addresses.pincode": { $ne: body.address.pincode }, "addresses.line1": { $ne: body.address.line1 } },
        { $push: { addresses: { $each: [body.address], $slice: -10 } } },
      );
    }
    const clearCart = async () => {
      cart.items.splice(0, cart.items.length);
      await cart.save();
    };

    const host = req.store?.primaryHost ?? req.header("x-store-host");
    if (body.paymentMethod === "cod") {
      const full = await Order.findById(order._id).select("+codConfirmToken").lean();
      await clearCart();
      await enqueueNotification({ type: "cod_confirm_request", tenantId, orderId: String(order._id), confirmUrl: `https://${host}/orders/${order._id}/confirm?token=${full!.codConfirmToken}` });
      return { orderId: order._id, number: order.number, status: order.status, payment: null };
    }
    let pay;
    try {
      pay = await provider!.createOrder({
      orderId: String(order._id),
      amountPaise: order.totals!.totalPaise!,
      customer: { id: req.customer!.sub, name: body.address.name, phone: body.address.phone, email: body.email },
      returnUrl: `https://${host}/orders/${order._id}?payment=return`,
      notifyUrl: `${env.PUBLIC_API_URL}/api/v1/webhooks/payments/${provider!.name}/${tenantId}`,
      });
    } catch (err) {
      // Gateway unreachable: release the reservation so stock isn't stuck.
      await transitionOrder(String(order._id), "payment_failed", { by: "system", note: "Could not start payment" });
      throw err;
    }
    await clearCart();
    await Order.updateOne({ _id: order._id }, { $set: { "payment.provider": provider!.name, "payment.providerOrderId": pay.providerOrderId, "payment.sessionId": pay.sessionId } });
    return { orderId: order._id, number: order.number, status: order.status, payment: pay.checkout };
  },
});

/** Called when the shopper returns from the gateway – asks the gateway directly instead of trusting the browser. */
add({
  method: "post", path: "/orders/:id/payment-status", summary: "Confirm payment status with the gateway", auth: "customer",
  params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }),
  body: z.object({ razorpayPaymentId: z.string().optional(), razorpaySignature: z.string().optional(), mockSuccess: z.boolean().optional() }).default({}),
  handler: async ({ req, params, body }) => {
    const order = await Order.findOne({ _id: params.id, customerId: req.customer!.sub });
    if (!order) throw notFound("Order");
    if (order.payment?.status === "paid" && order.status === "confirmed") return { status: order.status, paymentStatus: order.payment?.status };
    const provider = await getPaymentProvider(requireTenantId());

    let s;
    if (provider.name === "mock" && body?.mockSuccess === false) {
      s = { status: "failed" as const };
    } else {
      s = await provider.fetchStatus(order.payment?.providerOrderId!);
    }

    if (s.status === "paid") {
      await markOrderPaid(String(order._id), s.paymentId);
      const curr = await Order.findById(order._id);
      if (curr && ["pending_confirmation", "pending_payment"].includes(curr.status)) {
        await transitionOrder(String(order._id), "confirmed", { by: "system", note: "Paid online" });
      }
    } else if (s.status === "failed") {
      await transitionOrder(String(order._id), "payment_failed", { by: "system", note: "Payment failed in gateway" }).catch(() => undefined);
    }
    const fresh = await Order.findById(order._id).lean();
    return { status: fresh!.status, paymentStatus: fresh!.payment?.status };
  },
});

add({
  method: "post", path: "/orders/:id/pay", summary: "Initiate online payment for an unpaid order (e.g. COD or pending)", auth: "customer",
  params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }),
  handler: async ({ req, params }) => {
    const tenantId = requireTenantId();
    const order = await Order.findOne({ _id: params.id, customerId: req.customer!.sub });
    if (!order) throw notFound("Order");
    if (order.payment?.status === "paid") throw badRequest("Order is already paid");
    if (["cancelled", "delivered", "returned", "rto"].includes(order.status)) throw badRequest("Cannot pay for this order");

    const provider = await getPaymentProvider(tenantId);
    const host = req.store?.primaryHost ?? req.header("x-store-host");
    const pay = await provider.createOrder({
      orderId: String(order._id),
      amountPaise: order.totals!.totalPaise!,
      customer: { id: req.customer!.sub, name: order.shippingAddress?.name ?? "", phone: order.shippingAddress?.phone ?? "", email: order.customer?.email ?? undefined },
      returnUrl: `https://${host}/orders/${order._id}?payment=return`,
      notifyUrl: `${env.PUBLIC_API_URL}/api/v1/webhooks/payments/${provider.name}/${tenantId}`,
    });

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "payment.method": "online",
          "payment.provider": provider.name,
          "payment.providerOrderId": pay.providerOrderId,
          "payment.sessionId": pay.sessionId,
          "payment.status": "pending",
        },
      }
    );

    return { orderId: order._id, number: order.number, status: order.status, payment: pay.checkout };
  },
});

add({
  method: "post", path: "/orders/:id/confirm-cod-direct", summary: "Shopper directly confirms their cash-on-delivery order", auth: "customer",
  params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }),
  handler: async ({ req, params }) => {
    const order = await Order.findOne({ _id: params.id, customerId: req.customer!.sub });
    if (!order) throw notFound("Order");
    if (order.payment?.method !== "cod") throw badRequest("Not a cash-on-delivery order");
    if (order.status === "pending_confirmation") {
      await transitionOrder(params.id, "confirmed", { by: "customer", note: "COD confirmed by customer" });
    }
    return { number: order.number, status: "confirmed" };
  },
});

add({
  method: "post", path: "/orders/:id/confirm-cod", summary: "Shopper confirms a cash-on-delivery order", auth: "internal",
  params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }), body: z.object({ token: z.string().min(10) }),
  handler: async ({ params, body }) => {
    const order = await Order.findById(params.id).select("+codConfirmToken");
    if (!order || order.codConfirmToken !== body.token) throw notFound("Order");
    if (order.status === "pending_confirmation") await transitionOrder(params.id, "confirmed", { by: "customer", note: "COD confirmed by customer" });
    return { number: order.number, status: "confirmed" };
  },
});

add({
  method: "get", path: "/orders", summary: "My orders", auth: "customer",
  handler: ({ req }) => Order.find({ customerId: req.customer!.sub }).sort({ createdAt: -1 }).limit(50).select("number status totals createdAt items.title items.imageUrl items.quantity payment.method").lean(),
});

add({
  method: "get", path: "/orders/:id", summary: "My order details", auth: "customer", params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }),
  handler: async ({ req, params }) => (await Order.findOne({ _id: params.id, customerId: req.customer!.sub }).lean()) ?? Promise.reject(notFound("Order")),
});

add({
  method: "post", path: "/orders/:id/cancel", summary: "Cancel my order before it ships", auth: "customer", params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }),
  handler: async ({ req, params }) => {
    const order = await Order.findOne({ _id: params.id, customerId: req.customer!.sub }).lean();
    if (!order) throw notFound("Order");
    if (!["pending_payment", "pending_confirmation", "confirmed"].includes(order.status)) throw badRequest("This order can no longer be cancelled. Contact the store.");
    await transitionOrder(params.id, "cancelled", { by: "customer", note: "Cancelled by customer" });
    return { status: "cancelled", refundNote: order.payment?.status === "paid" ? "The store will refund your payment." : undefined };
  },
});

add({
  method: "get", path: "/orders/:id/invoice.pdf", summary: "Download my invoice", auth: "customer", params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }), raw: true,
  handler: async ({ req, res, params }) => {
    const order = await Order.findOne({ _id: params.id, customerId: req.customer!.sub }).select("status").lean();
    if (!order || !["confirmed", "packed", "shipped", "delivered", "returned", "refunded"].includes(order.status)) throw notFound("Invoice");
    const pdf = await orderInvoicePdf(requireTenantId(), params.id);
    res.type("application/pdf").send(pdf);
  },
});

add({
  method: "get", path: "/orders/:id/label.pdf", summary: "Download shipping label for my order", auth: "customer", params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }), raw: true,
  handler: async ({ req, res, params }) => {
    const order = await Order.findOne({ _id: params.id, customerId: req.customer!.sub }).select("status").lean();
    if (!order) throw notFound("Order");
    const pdf = await orderShippingLabelPdf(requireTenantId(), params.id);
    if (!pdf) throw notFound("Shipping label");
    res.type("application/pdf").setHeader("content-disposition", `inline; filename="shipping-label-${params.id}.pdf"`).send(pdf);
  },
});
