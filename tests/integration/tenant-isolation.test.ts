/**
 * Tenant isolation – the most important test in the codebase. Needs MongoDB (replica set):
 *   docker compose up -d mongo   then   MONGO_URL_TEST=mongodb://localhost:27017/ecom_test?replicaSet=rs0 npm test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose, { Types } from "mongoose";
import { runAsTenant, runWithoutTenant } from "../../src/db/tenantContext.js";
import { Product } from "../../src/models/catalog.js";

const enabled = !!process.env.MONGO_URL_TEST;
const A = new Types.ObjectId().toString();
const B = new Types.ObjectId().toString();
const variant = { sku: "S1", pricePaise: 1000, stock: 1 };

describe.skipIf(!enabled)("tenant isolation", () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URL_TEST!);
    await runWithoutTenant("test", () => Product.deleteMany({ tenantId: { $in: [A, B] } }));
    await runAsTenant(A, () => Product.create({ title: "A product", slug: "same-slug", variants: [variant] }));
    await runAsTenant(B, () => Product.create({ title: "B product", slug: "same-slug", variants: [variant] }));
  });
  afterAll(async () => {
    await runWithoutTenant("test", () => Product.deleteMany({ tenantId: { $in: [A, B] } }));
    await mongoose.disconnect();
  });

  it("each tenant only sees its own products", async () => {
    const a = await runAsTenant(A, () => Product.find().lean());
    expect(a.map((p) => p.title)).toEqual(["A product"]);
  });
  it("cannot read another tenant's document by id", async () => {
    const b = await runAsTenant(B, () => Product.findOne().lean());
    const leak = await runAsTenant(A, () => Product.findById(b!._id).lean());
    expect(leak).toBeNull();
  });
  it("cannot update or delete another tenant's data", async () => {
    await runAsTenant(A, () => Product.updateMany({}, { $set: { title: "hacked" } }));
    const b = await runAsTenant(B, () => Product.findOne().lean());
    expect(b!.title).toBe("B product");
    await runAsTenant(A, () => Product.deleteMany({}));
    expect(await runAsTenant(B, () => Product.countDocuments())).toBe(1);
  });
  it("aggregations are scoped", async () => {
    const r = await runAsTenant(B, () => Product.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]));
    expect(r[0].n).toBe(1);
  });
  it("throws when there is no tenant context", async () => {
    await expect(Product.find().lean()).rejects.toThrow(/tenant context/);
  });
  it("rejects saving a document for a different tenant", async () => {
    await expect(runAsTenant(A, () => Product.create({ tenantId: B, title: "x", slug: "x", variants: [variant] }))).rejects.toThrow(/mismatch/);
  });
});
