/**
 * Seeds a super-admin and (with --demo) a demo store with products.
 *   npm run seed            → super-admin only
 *   npm run seed -- --demo  → plus demo store "demo.<PLATFORM_DOMAIN>" and owner demo@store.test / DemoStore!123
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { connectDb } from "../src/db/connect.js";
import { runAsTenant, runWithoutTenant } from "../src/db/tenantContext.js";
import { PlatformAdmin, Tenant, Domain } from "../src/models/platform.js";
import { User } from "../src/models/people.js";
import { Category, Product, Page } from "../src/models/catalog.js";

await connectDb();
if (env.SUPERADMIN_EMAIL && env.SUPERADMIN_PASSWORD) {
  await PlatformAdmin.updateOne(
    { email: env.SUPERADMIN_EMAIL.toLowerCase() },
    { $setOnInsert: { email: env.SUPERADMIN_EMAIL.toLowerCase(), name: "Platform Admin", passwordHash: await bcrypt.hash(env.SUPERADMIN_PASSWORD, 12) } },
    { upsert: true },
  );
  console.log(`Super-admin ready: ${env.SUPERADMIN_EMAIL}`);
}

if (process.argv.includes("--demo")) {
  let tenant = await Tenant.findOne({ slug: "demo" });
  if (!tenant) {
    tenant = await Tenant.create({
      name: "Demo Saree House",
      slug: "demo",
      business: { legalName: "Demo Saree House", stateCode: "24", address: "Ring Road, Surat, Gujarat 395002", email: "orders@demo.test", phone: "9876543210", gstin: "24ABCDE1234F1Z5", grievanceOfficer: { name: "Asha Patel", email: "care@demo.test", phone: "9876543210" } },
      settings: { theme: "fashion", colors: { primary: "#6B1E3A", accent: "#D4A017", background: "#FFFDF8", text: "#2A1A1F" }, seo: { title: "Demo Saree House – handwoven sarees from Surat", description: "Silk and cotton sarees shipped across India." }, shippingOrigin: { pickupLocation: "Primary", pincode: "395002" } },
    });
    await Domain.create({ tenantId: tenant._id, hostname: `demo.${env.PLATFORM_DOMAIN}`, kind: "subdomain", status: "active", isPrimary: true });
    await Domain.create({ tenantId: tenant._id, hostname: "localhost", kind: "custom", status: "active" }).catch(() => undefined);
  }
  const ownerHash = await bcrypt.hash("DemoStore!123", 12);
  await runWithoutTenant("seed", () =>
    User.updateOne({ email: "demo@store.test" }, { $setOnInsert: { tenantId: tenant!._id, email: "demo@store.test", name: "Demo Owner", role: "owner", passwordHash: ownerHash } }, { upsert: true }),
  );
  await runAsTenant(String(tenant._id), async () => {
    if (await Product.countDocuments()) return;
    const [silk, cotton] = await Category.create([
      { name: "Silk sarees", slug: "silk-sarees", sortOrder: 1 },
      { name: "Cotton sarees", slug: "cotton-sarees", sortOrder: 2 },
    ]);
    const img = (seed: string) => `https://picsum.photos/seed/${seed}/800/1000`;
    const products = [
      ["Kanjivaram silk saree – temple border", silk!._id, 1249900, 1499900, "kanji"],
      ["Banarasi silk saree – zari buta", silk!._id, 899900, 1099900, "banarasi"],
      ["Patola double ikat saree", silk!._id, 2499900, null, "patola"],
      ["Handloom cotton saree – indigo", cotton!._id, 189900, 229900, "indigo"],
      ["Chanderi cotton silk saree", cotton!._id, 349900, null, "chanderi"],
      ["Kota doria saree – summer white", cotton!._id, 159900, null, "kota"],
    ] as const;
    for (const [title, cat, price, compare, seed] of products) {
      await Product.create({
        title,
        slug: seed + "-saree",
        description: `${title}. Handwoven, includes unstitched blouse piece. Dry clean recommended.`,
        brand: "Demo Saree House",
        categoryIds: [cat],
        images: [{ url: img(seed), alt: title }, { url: img(seed + "2"), alt: title }],
        optionNames: ["Colour"],
        variants: ["Maroon", "Teal"].map((c, i) => ({ sku: `${seed.toUpperCase()}-${c.slice(0, 3).toUpperCase()}`, options: { Colour: c }, pricePaise: price, compareAtPaise: compare, stock: 10 - i * 4, weightKg: 0.8 })),
        hsn: "5007",
        gstRatePercent: 5,
        isFeatured: seed === "kanji" || seed === "indigo",
      });
    }
    await Page.create([
      { title: "About us", slug: "about", body: "We are a family-run saree house in Surat, weaving and sourcing since 1987." },
      { title: "Shipping policy", slug: "shipping-policy", body: "Orders ship within 2 working days. Delivery in 3–7 days across India." },
      { title: "Returns & refunds", slug: "refund-policy", body: "Unused items can be returned within 7 days of delivery. Refunds are processed within 5–7 working days." },
      { title: "Privacy policy", slug: "privacy-policy", body: "We use your details only to process and deliver your orders." },
      { title: "Terms of service", slug: "terms", body: "By placing an order you agree to these terms." },
    ]);
  });
  console.log(`Demo store ready: http://demo.${env.PLATFORM_DOMAIN} (owner demo@store.test / DemoStore!123)`);
}
await mongoose.disconnect();
