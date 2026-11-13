import { z } from "zod";
import { Types } from "mongoose";
import { moduleFor, escapeRegex, queryDateFrom, queryDateTo } from "./_shared.js";
import { Order, ORDER_STATUSES, type OrderStatus } from "../models/orders.js";
import { Customer } from "../models/people.js";
import { Tenant } from "../models/platform.js";
import { Commission } from "../models/billing.js";
import { env } from "../config/env.js";
import { idParams, pagination } from "../http/route.js";
import { notFound, badRequest, conflict } from "../lib/errors.js";
import { requireTenantId } from "../db/tenantContext.js";
import { transitionOrder, refundOrder } from "../services/orders.js";
import { getShippingProvider } from "../integrations/shipping/index.js";
import { orderInvoicePdf, orderShippingLabelPdf } from "../services/statements.js";

const { router, add } = moduleFor("Orders", "/api/v1/admin");
export default router;

add({
  method: "get", path: "/orders", summary: "List orders", auth: "merchant",
  query: pagination.extend({ status: z.enum(ORDER_STATUSES).optional(), q: z.string().optional(), method: z.enum(["online", "cod"]).optional(), from: queryDateFrom.optional(), to: queryDateTo.optional() }),
  handler: async ({ query }) => {
    const f: any = {};
    if (query.status) f.status = query.status;
    if (query.method) f["payment.method"] = query.method;
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), "i");
      f.$or = [{ number: rx }, { "customer.phone": rx }, { "customer.name": rx }, { "shipment.awb": rx }];
    }
    if (query.from || query.to) f.createdAt = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
    const [items, total] = await Promise.all([
      Order.find(f).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).select("number customer status totals payment.method payment.status shipment.awb createdAt").lean(),
      Order.countDocuments(f),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  },
});

add({
  method: "get", path: "/orders/:id", summary: "Order details", auth: "merchant", params: idParams,
  handler: async ({ params }) => {
    const order = await Order.findById(params.id).lean();
    if (!order) throw notFound("Order");
    if (order.shipment && (!order.shipment.labelUrl || order.shipment.labelUrl.includes("example.com"))) {
      order.shipment.labelUrl = `/api/v1/admin/orders/${order._id}/label.pdf`;
    }
    return order;
  },
});

add({
  method: "post", path: "/orders/:id/status", summary: "Change order status", auth: "merchant", params: idParams,
  body: z.object({ status: z.enum(ORDER_STATUSES), note: z.string().max(1000).optional() }),
  handler: ({ params, body, req }) => {
    // "refunded" only through the owner-only refund endpoint, which actually returns the money and adjusts commission.
    if (body.status === "refunded") throw badRequest("Use Refund to refund an order. It returns the money and records it.");
    return transitionOrder(params.id, body.status as OrderStatus, { by: `user:${req.auth!.sub}`, note: body.note });
  },
});

add({
  method: "post", path: "/orders/:id/refund", summary: "Refund an order (full or partial)", auth: "owner", params: idParams,
  body: z.object({ amountPaise: z.number().int().positive().optional(), reason: z.string().trim().min(2).max(500) }),
  handler: ({ params, body, req }) => refundOrder(params.id, body.amountPaise, body.reason, `user:${req.auth!.sub}`),
});

add({
  method: "post", path: "/orders/:id/shipment", summary: "Create shipment with the connected courier", auth: "merchant", params: idParams,
  body: z.object({ weightKg: z.number().positive().optional(), dims: z.object({ l: z.number(), b: z.number(), h: z.number() }).optional() }).default({}),
  handler: async ({ params, body, req }) => {
    const tenantId = requireTenantId();
    const order = await Order.findById(params.id);
    if (!order) throw notFound("Order");
    if (!["confirmed", "packed"].includes(order.status)) throw badRequest("Only confirmed or packed orders can be shipped");
    if (order.shipment?.awb) throw badRequest("A shipment already exists for this order");
    const tenant = await Tenant.findById(tenantId).lean();
    const origin = tenant?.settings?.shippingOrigin;
    if (!origin?.pickupLocation) throw badRequest("Set your pickup location in Settings → Shipping first");
    // Claim a booking lock first so a double click can't book two shipments (a stale lock expires after 2 minutes).
    const locked = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: ["confirmed", "packed"] },
        "shipment.awb": { $in: [null, ""] },
        $or: [{ shipmentLockAt: null }, { shipmentLockAt: { $lt: new Date(Date.now() - 2 * 60_000) } }],
      },
      { $set: { shipmentLockAt: new Date() } },
      { new: true },
    );
    if (!locked) throw conflict("A shipment is already being created for this order. Wait a moment and reload.");
    const weight = body.weightKg ?? order.items.reduce((s, i) => s + (i.weightKg ?? origin.defaultWeightKg ?? 0.5) * (i.quantity ?? 1), 0);
    const a = order.shippingAddress!;
    let provider: Awaited<ReturnType<typeof getShippingProvider>>;
    let r: Awaited<ReturnType<typeof provider.createShipment>>;
    try {
      provider = await getShippingProvider(tenantId);
      r = await provider.createShipment({
        orderNumber: order.number,
        orderDate: order.createdAt as Date,
        paymentMethod: order.payment!.method as "online" | "cod",
        totalPaise: order.totals!.totalPaise!,
        subtotalPaise: order.totals!.subtotalPaise ?? order.totals!.totalPaise!,
        customer: { name: order.customer!.name!, phone: order.customer!.phone!, email: order.customer?.email ?? undefined },
        address: { line1: a.line1!, line2: a.line2 ?? undefined, city: a.city!, state: a.state!, pincode: a.pincode! },
        items: order.items.map((i) => ({ name: i.title!, sku: i.sku!, units: i.quantity!, sellingPricePaise: i.unitPricePaise!, hsn: i.hsn ?? undefined })),
        weightKg: Math.max(0.1, Math.round(weight * 100) / 100),
        dims: body.dims ?? { l: origin.dims?.l ?? 20, b: origin.dims?.b ?? 15, h: origin.dims?.h ?? 5 },
        pickupLocation: origin.pickupLocation,
      });
    } catch (err) {
      await Order.updateOne({ _id: order._id }, { $unset: { shipmentLockAt: 1 } });
      throw err;
    }
    const labelUrl = (r.labelUrl && !r.labelUrl.includes("example.com")) ? r.labelUrl : `/api/v1/admin/orders/${order._id}/label.pdf`;
    locked.shipment = { provider: provider.name, providerOrderId: r.providerOrderId, shipmentId: r.shipmentId, awb: r.awb, courier: r.courier, labelUrl, trackingUrl: r.trackingUrl, status: "created", events: [] } as any;
    locked.shipmentLockAt = undefined;
    await locked.save();
    if (locked.status === "confirmed") await transitionOrder(params.id, "packed", { by: `user:${req.auth!.sub}`, note: "Shipment created" });
    return Order.findById(params.id).lean();
  },
});

add({
  method: "post", path: "/orders/:id/shipment/sync", summary: "Refresh tracking from the courier", auth: "merchant", params: idParams,
  handler: async ({ params }) => {
    const order = await Order.findById(params.id);
    if (!order?.shipment?.awb) throw badRequest("This order has no shipment yet");
    const provider = await getShippingProvider(requireTenantId());
    const t = await provider.track(order.shipment.awb);
    order.shipment.status = t.status;
    order.shipment.events = t.events as any;
    await order.save();
    const map: Record<string, OrderStatus> = { shipped: "shipped", in_transit: "shipped", delivered: "delivered", rto: "rto" };
    const target = map[t.normalized];
    if (target && target !== order.status) {
      if (target === "delivered" && order.status !== "shipped") await transitionOrder(params.id, "shipped", { by: "courier" }).catch(() => undefined);
      await transitionOrder(params.id, target, { by: "courier" }).catch(() => undefined);
    }
    return Order.findById(params.id).lean();
  },
});

add({
  method: "post", path: "/orders/:id/shipment/cancel", summary: "Cancel the courier shipment", auth: "merchant", params: idParams,
  handler: async ({ params }) => {
    const order = await Order.findById(params.id);
    if (!order?.shipment?.providerOrderId) throw badRequest("This order has no shipment");
    if (order.status === "shipped") throw badRequest("The parcel is already with the courier");
    await (await getShippingProvider(requireTenantId())).cancel(order.shipment.providerOrderId);
    order.shipment = undefined as any;
    await order.save();
    return order;
  },
});

add({
  method: "get", path: "/orders/:id/invoice.pdf", summary: "Download the customer tax invoice", auth: "merchant", params: idParams, raw: true,
  handler: async ({ params, res }) => {
    const pdf = await orderInvoicePdf(requireTenantId(), params.id);
    if (!pdf) throw notFound("Order");
    res.type("application/pdf").setHeader("content-disposition", `inline; filename="invoice-${params.id}.pdf"`);
    res.send(pdf);
  },
});

add({
  method: "get", path: "/orders/:id/label.pdf", summary: "Download the courier shipping label", auth: "merchant", params: idParams, raw: true,
  handler: async ({ params, res }) => {
    const pdf = await orderShippingLabelPdf(requireTenantId(), params.id);
    if (!pdf) throw notFound("Order or shipment");
    res.type("application/pdf").setHeader("content-disposition", `inline; filename="shipping-label-${params.id}.pdf"`);
    res.send(pdf);
  },
});

// ---------- Customers ----------
add({
  method: "get", path: "/customers", summary: "List customers", auth: "merchant",
  query: pagination.extend({ q: z.string().optional() }),
  handler: async ({ query }) => {
    const f: any = {};
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), "i");
      f.$or = [{ phone: rx }, { name: rx }, { email: rx }];
    }
    const [items, total] = await Promise.all([
      Customer.find(f).sort({ lastOrderAt: -1, createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      Customer.countDocuments(f),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  },
});
add({
  method: "get", path: "/customers/:id", summary: "Customer details with orders", auth: "merchant", params: idParams,
  handler: async ({ params }) => {
    const c = await Customer.findById(params.id).lean();
    if (!c) throw notFound("Customer");
    const orders = await Order.find({ customerId: new Types.ObjectId(params.id) }).sort({ createdAt: -1 }).limit(50).select("number status totals createdAt").lean();
    return { ...c, orders };
  },
});

// ---------- Dashboard ----------
const dashboardQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  period: z.enum(["today", "yesterday", "7d", "14d", "30d", "90d", "custom"]).default("30d"),
  from: queryDateFrom.optional(),
  to: queryDateTo.optional(),
  paymentMethod: z.enum(["all", "online", "cod"]).default("all"),
});

add({
  method: "get", path: "/dashboard", summary: "Store dashboard numbers", auth: "merchant",
  query: dashboardQuery,
  handler: async ({ query }) => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(now.getTime() + istOffset);
    const startOfTodayIst = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - istOffset);
    const startOfYesterdayIst = new Date(startOfTodayIst.getTime() - 86_400_000);
    const endOfYesterdayIst = new Date(startOfTodayIst.getTime() - 1);

    let since = new Date(now.getTime() - 30 * 86_400_000);
    let until = now;

    if (query.days) {
      since = new Date(now.getTime() - query.days * 86_400_000);
    } else if (query.period === "today") {
      since = startOfTodayIst;
    } else if (query.period === "yesterday") {
      since = startOfYesterdayIst;
      until = endOfYesterdayIst;
    } else if (query.period === "7d") {
      since = new Date(now.getTime() - 7 * 86_400_000);
    } else if (query.period === "14d") {
      since = new Date(now.getTime() - 14 * 86_400_000);
    } else if (query.period === "30d") {
      since = new Date(now.getTime() - 30 * 86_400_000);
    } else if (query.period === "90d") {
      since = new Date(now.getTime() - 90 * 86_400_000);
    } else if (query.period === "custom") {
      if (query.from) since = query.from;
      if (query.to) until = query.to;
    }

    const methodFilter = query.paymentMethod !== "all" ? { "payment.method": query.paymentMethod } : {};
    const counted = { status: { $in: ["confirmed", "packed", "shipped", "delivered"] } };

    const [
      series,
      todayAgg,
      yesterdayAgg,
      top,
      split,
      pending,
      lowStock,
      totalOrdersCount,
      deliveredOrdersCount,
      customerReturnsAgg,
      rtoAgg,
      reasonsAgg,
      highReturnProducts,
      pickupPendingCount,
      inTransitCount,
      outForDeliveryCount,
      deliveredCount,
      rtoCount,
      slaBreachedCount,
      onlineSettled,
      onlineInFlight,
      codCollected,
      codPending,
      packedCount,
      commissionAgg,
    ] = await Promise.all([
      // 1. Time Series Daily Aggregation (Selling & Returns)
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: since, $lte: until },
            ...methodFilter,
            status: { $nin: ["pending_payment", "cancelled", "payment_failed"] },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
            orders: { $sum: 1 },
            grossSalesPaise: { $sum: "$totals.totalPaise" },
            salesPaise: { $sum: "$totals.totalPaise" }, // backwards compatibility
            netSalesPaise: {
              $sum: {
                $cond: [{ $in: ["$status", ["confirmed", "packed", "shipped", "delivered"]] }, "$totals.totalPaise", 0],
              },
            },
            units: { $sum: { $sum: "$items.quantity" } },
            returns: {
              $sum: { $cond: [{ $in: ["$status", ["returned", "refunded"]] }, 1, 0] },
            },
            rto: {
              $sum: { $cond: [{ $eq: ["$status", "rto"] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // 2. Today's Performance
      Order.aggregate([
        { $match: { ...counted, createdAt: { $gte: startOfTodayIst } } },
        { $group: { _id: null, orders: { $sum: 1 }, salesPaise: { $sum: "$totals.totalPaise" } } },
      ]),

      // 3. Yesterday's Performance (for growth benchmark)
      Order.aggregate([
        { $match: { ...counted, createdAt: { $gte: startOfYesterdayIst, $lte: endOfYesterdayIst } } },
        { $group: { _id: null, orders: { $sum: 1 }, salesPaise: { $sum: "$totals.totalPaise" } } },
      ]),

      // 4. Best Sellers
      Order.aggregate([
        { $match: { ...counted, createdAt: { $gte: since, $lte: until }, ...methodFilter } },
        { $unwind: "$items" },
        { $group: { _id: "$items.productId", title: { $first: "$items.title" }, units: { $sum: "$items.quantity" }, salesPaise: { $sum: "$items.lineTotalPaise" } } },
        { $sort: { units: -1 } },
        { $limit: 5 },
      ]),

      // 5. Payment Mix
      Order.aggregate([
        { $match: { ...counted, createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: "$payment.method", orders: { $sum: 1 } } },
      ]),

      // 6. Action: Orders to Process
      Order.countDocuments({ status: { $in: ["confirmed", "pending_confirmation"] } }),

      // 7. Action: Low Stock Products
      (await import("../models/catalog.js")).Product.countDocuments({ status: "active", "variants.stock": { $lte: 5 } }),

      // 8. Total Orders Placed in Period
      Order.countDocuments({ createdAt: { $gte: since, $lte: until }, ...methodFilter, status: { $nin: ["pending_payment", "cancelled", "payment_failed"] } }),

      // 9. Delivered Orders in Period
      Order.countDocuments({ createdAt: { $gte: since, $lte: until }, ...methodFilter, status: "delivered" }),

      // 10. Customer Returns Aggregation
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: since, $lte: until },
            ...methodFilter,
            $or: [{ status: { $in: ["returned", "refunded"] } }, { "returnDetails.type": "customer_return" }],
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, lossPaise: { $sum: "$totals.totalPaise" } } },
      ]),

      // 11. Courier RTO Aggregation
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: since, $lte: until },
            ...methodFilter,
            $or: [{ status: "rto" }, { "returnDetails.type": "courier_rto" }],
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, lossPaise: { $sum: "$totals.totalPaise" } } },
      ]),

      // 12. Return Reasons Breakdown
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: since, $lte: until },
            ...methodFilter,
            status: { $in: ["returned", "rto", "refunded"] },
          },
        },
        {
          $group: {
            _id: {
              $ifNull: [
                "$returnDetails.reasonCategory",
                { $cond: [{ $eq: ["$status", "rto"] }, "Customer Refused COD / Unreached", "Size Mismatch / Fabric Expectation"] },
              ],
            },
            count: { $sum: 1 },
            amountPaise: { $sum: "$totals.totalPaise" },
          },
        },
        { $sort: { count: -1 } },
      ]),

      // 13. High Return Products (Quality Control Alert)
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: since, $lte: until },
            status: { $in: ["returned", "rto", "refunded"] },
          },
        },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            title: { $first: "$items.title" },
            returnedUnits: { $sum: "$items.quantity" },
            lossPaise: { $sum: "$items.lineTotalPaise" },
          },
        },
        { $sort: { returnedUnits: -1 } },
        { $limit: 4 },
      ]),

      // 14. Logistics Funnel: Pickup Pending
      Order.countDocuments({ status: { $in: ["confirmed", "packed"] }, "shipment.awb": { $exists: false } }),

      // 15. Logistics Funnel: In Transit
      Order.countDocuments({ status: "shipped", "shipment.status": { $ne: "out_for_delivery" } }),

      // 16. Logistics Funnel: Out For Delivery
      Order.countDocuments({ $or: [{ "shipment.status": "out_for_delivery" }, { "shipment.currentStage": "out_for_delivery" }] }),

      // 17. Logistics Funnel: Delivered (Period)
      Order.countDocuments({ status: "delivered", createdAt: { $gte: since, $lte: until } }),

      // 18. Logistics Funnel: RTO (Period)
      Order.countDocuments({ status: "rto", createdAt: { $gte: since, $lte: until } }),

      // 19. Dispatch SLA Breached (>24 hours unfulfilled)
      Order.countDocuments({ status: "confirmed", createdAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }),

      // 20. Settlements: Online Settled
      Order.aggregate([
        { $match: { "payment.method": "online", "payment.status": "paid", "payment.settlementStatus": "settled", createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$totals.totalPaise" } } },
      ]),

      // 21. Settlements: Online In-Flight (T+1 clearing)
      Order.aggregate([
        { $match: { "payment.method": "online", "payment.status": "paid", "payment.settlementStatus": { $ne: "settled" }, createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$totals.totalPaise" } } },
      ]),

      // 22. Settlements: COD Remitted by Courier
      Order.aggregate([
        { $match: { "payment.method": "cod", status: "delivered", "payment.status": "cod_collected", createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$totals.totalPaise" } } },
      ]),

      // 23. Settlements: COD Pending Remittance
      Order.aggregate([
        { $match: { "payment.method": "cod", status: "delivered", "payment.status": { $ne: "cod_collected" }, createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$totals.totalPaise" } } },
      ]),

      // 24. Action: Ready to Ship (Packed)
      Order.countDocuments({ status: "packed" }),

      // 25. Platform commission accrued on orders in the period (real rate and base, not a flat 3% of gross)
      Commission.aggregate([
        { $match: { status: { $in: ["accrued", "billed"] }, accruedAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$amountPaise" } } },
      ]),
    ]);

    const grossSalesPaise = series.reduce((s, x) => s + x.grossSalesPaise, 0);
    const netSalesPaise = series.reduce((s, x) => s + x.netSalesPaise, 0);
    const totalOrders = totalOrdersCount;
    const aovPaise = totalOrders > 0 ? Math.round(grossSalesPaise / totalOrders) : 0;

    const custReturnsCount = customerReturnsAgg[0]?.count ?? 0;
    const rtoCountVal = rtoAgg[0]?.count ?? 0;
    const totalReturns = custReturnsCount + rtoCountVal;
    const returnRatePercent = totalOrders > 0 ? Math.round((totalReturns / totalOrders) * 1000) / 10 : 0;

    // Real aggregates only: 0 when there is nothing recorded (these used to fall back to invented shares of gross sales).
    const onlineSettledPaise = onlineSettled[0]?.total ?? 0;
    const onlineInFlightPaise = onlineInFlight[0]?.total ?? 0;
    const codCollectedPaise = codCollected[0]?.total ?? 0;
    const codPendingRemittancePaise = codPending[0]?.total ?? 0;
    const commissionPaise = commissionAgg[0]?.total ?? 0;
    const platformFeeEstimatedPaise = commissionPaise + Math.round((commissionPaise * env.COMMISSION_GST_PERCENT) / 100); // commission + GST

    // Next Tuesday / Friday payout cycle date
    const nextPayoutDate = new Date();
    nextPayoutDate.setDate(nextPayoutDate.getDate() + ((2 + 7 - nextPayoutDate.getDay()) % 7 || 3));

    return {
      // Historical compatibility
      series,
      today: todayAgg[0] ?? { orders: 0, salesPaise: 0 },
      topProducts: top,
      paymentSplit: Object.fromEntries(split.map((s) => [s._id, s.orders])),
      ordersToProcess: pending,
      lowStockProducts: lowStock,

      // Enhanced Meesho-grade modules
      summary: {
        grossSalesPaise,
        netSalesPaise,
        totalOrders,
        deliveredOrders: deliveredOrdersCount,
        aovPaise,
        yesterdaySalesPaise: yesterdayAgg[0]?.salesPaise ?? 0,
        yesterdayOrders: yesterdayAgg[0]?.orders ?? 0,
      },
      returns: {
        totalReturns,
        customerReturns: custReturnsCount,
        courierRto: rtoCountVal,
        returnRatePercent,
        customerReturnLossPaise: customerReturnsAgg[0]?.lossPaise ?? 0,
        rtoLossPaise: rtoAgg[0]?.lossPaise ?? 0,
        reasonsBreakdown: reasonsAgg.map((r) => ({
          reason: String(r._id).replace(/_/g, " "),
          count: r.count,
          amountPaise: r.amountPaise,
          percentage: totalReturns > 0 ? Math.round((r.count / totalReturns) * 100) : 0,
        })),
        highReturnProducts,
      },
      logistics: {
        pickupPending: pickupPendingCount,
        inTransit: inTransitCount,
        outForDelivery: outForDeliveryCount,
        delivered: deliveredCount,
        rto: rtoCount,
        slaBreachedCount,
      },
      settlements: {
        onlineSettledPaise,
        onlineInFlightPaise,
        codCollectedPaise,
        codPendingRemittancePaise,
        platformFeeEstimatedPaise,
        nextPayoutDate: nextPayoutDate.toISOString(),
      },
      actions: {
        toPack: pending - packedCount > 0 ? pending - packedCount : pending,
        readyToShip: packedCount,
        outForDelivery: outForDeliveryCount,
        returnsToVerify: custReturnsCount > 0 ? Math.min(3, custReturnsCount) : 0,
        lowStock,
      },
    };
  },
});
