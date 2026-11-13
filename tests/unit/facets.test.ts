/**
 * Attribute filtering + facet aggregation used by the storefront browse API (store.ts GET /products).
 * DB-gated like the tenant-isolation suite:
 *   docker compose up -d mongo
 *   MONGO_URL_TEST="mongodb://localhost:27017/ecom_test?replicaSet=rs0" npm test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose, { Types } from "mongoose";
import { runAsTenant, runWithoutTenant } from "../../src/db/tenantContext.js";
import { Product } from "../../src/models/catalog.js";
import { FILTERABLE_ATTRS } from "../../src/modules/catalogAttrs.js";

const enabled = !!process.env.MONGO_URL_TEST;
const T = new Types.ObjectId().toString();
const variant = { sku: "S1", pricePaise: 100000, stock: 5 };

// Mirrors the route's facet pipeline for one key.
const facetPipeline = (k: string) => [
  { $match: { [`attributes.${k}`]: { $exists: true, $ne: [] } } },
  { $unwind: `$attributes.${k}` },
  { $sortByCount: `$attributes.${k}` },
  { $project: { _id: 0, value: "$_id", count: 1 } },
];

describe.skipIf(!enabled)("product attribute filtering & facets", () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URL_TEST!);
    await runWithoutTenant("test", () => Product.deleteMany({ tenantId: T }));
    await runAsTenant(T, () =>
      Product.create([
        {
          title: "Leather Daily",
          slug: "leather-daily",
          variants: [variant],
          attributes: { strap: ["Leather"], occasion: ["Daily wear", "Casual"] },
        },
        {
          title: "Steel Daily",
          slug: "steel-daily",
          variants: [variant],
          attributes: { strap: ["Stainless Steel"], occasion: ["Daily wear"] },
        },
        { title: "Silicone Sport", slug: "silicone-sport", variants: [variant], attributes: { strap: ["Silicone"], occasion: ["Sports"] } },
      ]),
    );
  });
  afterAll(async () => {
    await runWithoutTenant("test", () => Product.deleteMany({ tenantId: T }));
    await mongoose.disconnect();
  });

  it("filters by a single attribute value (Map field $in)", async () => {
    const r = await runAsTenant(T, () =>
      Product.find({ "attributes.occasion": { $in: ["Daily wear"] } })
        .select("slug")
        .lean(),
    );
    expect(r.map((p) => p.slug).sort()).toEqual(["leather-daily", "steel-daily"]);
  });

  it("filters by a different attribute (strap)", async () => {
    const r = await runAsTenant(T, () => Product.find({ "attributes.strap": { $in: ["Leather"] } }).lean());
    expect(r.map((p) => p.slug)).toEqual(["leather-daily"]);
  });

  it("supports multi-value $in (Leather OR Silicone)", async () => {
    const r = await runAsTenant(T, () => Product.find({ "attributes.strap": { $in: ["Leather", "Silicone"] } }).lean());
    expect(r.map((p) => p.slug).sort()).toEqual(["leather-daily", "silicone-sport"]);
  });

  it("aggregates facet counts per value", async () => {
    const agg = await runAsTenant(T, () =>
      Product.aggregate([{ $match: { status: "active" } }, { $facet: { occasion: facetPipeline("occasion") } }]),
    );
    const counts = Object.fromEntries(agg[0].occasion.map((f: { value: string; count: number }) => [f.value, f.count]));
    expect(counts["Daily wear"]).toBe(2);
    expect(counts["Casual"]).toBe(1);
    expect(counts["Sports"]).toBe(1);
  });

  it("exposes every declared facet key (smoke)", () => {
    expect(FILTERABLE_ATTRS).toContain("strap");
    expect(FILTERABLE_ATTRS).toContain("occasion");
  });
});
