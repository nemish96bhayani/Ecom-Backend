/**
 * Order concurrency edge cases (C2, C11, C12, C15). Needs MongoDB (replica set), like tenant-isolation:
 *   MONGO_URL_TEST=mongodb://localhost:27017/ecom_test?replicaSet=rs0 npm test
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose, { Types } from "mongoose";

vi.mock("../../src/jobs/queues.js", () => ({ enqueueNotification: vi.fn(async () => undefined) }));

const { runAsTenant, runWithoutTenant } = await import("../../src/db/tenantContext.js");
const { Order } = await import("../../src/models/orders.js");
const { Coupon, Product } = await import("../../src/models/catalog.js");
const { transitionOrder, refundOrder } = await import("../../src/services/orders.js");

const enabled = !!process.env.MONGO_URL_TEST;
const T = new Types.ObjectId().toString();

const baseOrder = (over: Record<string, unknown> = {}): any => ({
  number: `T-${new Types.ObjectId().toString().slice(-8)}`,
  customer: { name: "A", phone: "9999999999" },
  items: [],
  totals: { subtotalPaise: 1000, totalPaise: 1000 },
  status: "confirmed",
  statusHistory: [{ status: "confirmed", by: "test" }],
  payment: { method: "cod", status: "cod_pending" },
  ...over,
});

describe.skipIf(!enabled)("order concurrency", () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URL_TEST!);
  });
  afterAll(async () => {
    await runWithoutTenant("test cleanup", () =>
      Promise.all([Order.deleteMany({ tenantId: T }), Coupon.deleteMany({ tenantId: T }), Product.deleteMany({ tenantId: T })]),
    );
    await mongoose.disconnect();
  });

  it("C11: two racing transitions – exactly one applies", async () => {
    const o = await runAsTenant(T, () => Order.create(baseOrder()));
    const results = await runAsTenant(T, () =>
      Promise.allSettled([
        transitionOrder(String(o._id), "shipped", { by: "a" }),
        transitionOrder(String(o._id), "cancelled", { by: "b" }),
      ]),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([400, 409]).toContain(rejected.reason.status);
    const fresh = await runAsTenant(T, () => Order.findById(o._id).lean());
    expect(fresh!.statusHistory).toHaveLength(2);
  });

  it("C11: the same transition twice in parallel records it once", async () => {
    const o = await runAsTenant(T, () => Order.create(baseOrder()));
    await runAsTenant(T, () =>
      Promise.all([transitionOrder(String(o._id), "packed", { by: "a" }), transitionOrder(String(o._id), "packed", { by: "b" })]),
    );
    const fresh = await runAsTenant(T, () => Order.findById(o._id).lean());
    expect(fresh!.statusHistory.filter((h) => h.status === "packed")).toHaveLength(1);
  });

  it("C12: can't cancel once an AWB exists", async () => {
    const o = await runAsTenant(T, () => Order.create(baseOrder({ status: "packed", shipment: { awb: "AWB123", provider: "mock" } })));
    await expect(runAsTenant(T, () => transitionOrder(String(o._id), "cancelled", { by: "a" }))).rejects.toMatchObject({ status: 409 });
  });

  it("C2: two parallel refunds can't exceed the amount paid", async () => {
    const o = await runAsTenant(T, () =>
      Order.create(baseOrder({ status: "delivered", payment: { method: "cod", status: "cod_collected" } })),
    );
    const results = await runAsTenant(T, () =>
      Promise.allSettled([refundOrder(String(o._id), 600, "r1", "a"), refundOrder(String(o._id), 600, "r2", "b")]),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const fresh = await runAsTenant(T, () => Order.findById(o._id).lean());
    const refunded = fresh!.payment!.refunds.reduce((s, r) => s + (r.amountPaise ?? 0), 0);
    expect(refunded).toBe(600);
    expect(fresh!.payment!.status).toBe("partially_refunded");
  });

  it("C10: an uncollected COD order can't be refunded", async () => {
    const o = await runAsTenant(T, () => Order.create(baseOrder()));
    await expect(runAsTenant(T, () => refundOrder(String(o._id), 100, "r", "a"))).rejects.toMatchObject({ status: 400 });
  });

  it("C15: cancelling an unconfirmed order hands the coupon redemption back once", async () => {
    await runAsTenant(T, () => Coupon.create({ code: "EDGE10", type: "percent", value: 10, usedCount: 3 }));
    const o = await runAsTenant(T, () =>
      Order.create(
        baseOrder({
          status: "pending_confirmation",
          statusHistory: [{ status: "pending_confirmation", by: "t" }],
          couponCode: "EDGE10",
          stockReleased: true,
        }),
      ),
    );
    await runAsTenant(T, () => transitionOrder(String(o._id), "cancelled", { by: "a" }));
    const c = await runAsTenant(T, () => Coupon.findOne({ code: "EDGE10" }).lean());
    expect(c!.usedCount).toBe(2);
    const fresh = await runAsTenant(T, () => Order.findById(o._id).lean());
    expect(fresh!.couponReleased).toBe(true);
  });
});
