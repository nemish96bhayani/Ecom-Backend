/**
 * Seeds the "Sorath Watch" store: tenant + domains + owner, a themed homepage
 * (hero + two offer posters), 6 categories and ~22 watches with full filter-attribute
 * coverage (strap, colour, dial, lock, occasion, movement, gender), pages and coupons.
 *
 *   npm run seed:sorath
 *
 * Idempotent: upserts the tenant/owner by slug/email and rebuilds the store's catalog each run.
 * Images are generic Unsplash/picsum PLACEHOLDERS — replace with real product photos before launch.
 * Business/legal details are clearly-labelled placeholders — not a real registered business.
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { connectDb } from "../src/db/connect.js";
import { runAsTenant, runWithoutTenant } from "../src/db/tenantContext.js";
import { Tenant, Domain } from "../src/models/platform.js";
import { User } from "../src/models/people.js";
import { Category, Product, Coupon, Page } from "../src/models/catalog.js";

const SLUG = "sorath-watch";
const OWNER_EMAIL = "owner@sorathwatch.test";
const OWNER_PASSWORD = "SorathWatch!123";
// Free, direct Unsplash watch photos (Unsplash License) for DEMO only — replace with real product photography before launch.
const U = (id: string, w: number, h: number) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&q=80&auto=format&fit=crop`;
const WATCH_IMAGES = [
  "1523275335684-37898b6baf30", "1524592094714-0f0654e20314", "1434056886845-dac89ffe9b56",
  "1508057198894-247b23fe5ade", "1526045431048-f857369baa09", "1587836374828-4dbafa94cf0e",
  "1495704907664-81f74a7efd9b", "1619134778706-7015533a6150", "1611591437281-460bfbe1220a",
  "1509048191080-d2984bad6ae5", "1434493789847-2f02dc6ca35d", "1465479423260-c4afc24172c6",
  "1522312346375-d1a52e2b99b3", "1533139502658-0198f920d8e8", "1612817159949-195b6eb9e31a",
  "1547996160-81dfa63595aa", "1542496658-e33a6d0d50f6", "1620625515032-6ed0c1790c75",
  "1524805444758-089113d48a6d", "1596516109370-29001ec8ec36",
];
const HERO_IMAGES = ["1523170335258-f5ed11844a49", "1622434641406-a158123450f9", "1767009951316-c3d2b63179ef"];
const prodImg = (i: number, w = 800, h = 1000) => U(WATCH_IMAGES[((i % WATCH_IMAGES.length) + WATCH_IMAGES.length) % WATCH_IMAGES.length], w, h);

await connectDb();

// ---- Tenant + settings (hero banner[0] + two offer posters) ----
const settings = {
  theme: "general" as const,
  colors: { primary: "#1F2430", accent: "#3C6E9A", background: "#F6F4EF", text: "#18181B" },
  font: "Figtree",
  homeSections: ["hero", "categories", "featured", "new", "about"],
  logoUrl: "/sorath-logo.png",
  seo: {
    title: "Sorath Watch — timepieces for every occasion",
    description: "Watches for men and women: leather, steel, chronograph and smart. Strap, dial and occasion filters to find your fit.",
  },
  banners: [
    {
      imageUrl: U(HERO_IMAGES[0], 1600, 640),
      title: "Time, Refined",
      subtitle: "Handpicked watches for daily wear, work and festive occasions.",
      link: "/c/mens-watches",
    },
    {
      imageUrl: U(HERO_IMAGES[1], 1200, 520),
      title: "Festive Edit — up to 40% off",
      subtitle: "Dress & occasion watches for the season",
      link: "/c/ethnic-festive",
    },
    { imageUrl: U(HERO_IMAGES[2], 1200, 520), title: "Sports & Smart", subtitle: "Built for the everyday athlete", link: "/c/sports" },
  ],
  whatsappNumber: "9876500000",
  social: { instagram: "https://instagram.com/", facebook: "https://facebook.com/" },
  checkout: {
    codEnabled: true,
    codMaxPaise: 5000000,
    prepaidDiscountPaise: 5000,
    freeShippingAbovePaise: 199900,
    flatShippingPaise: 7900,
    codFeePaise: 4900,
  },
  shippingOrigin: { pickupLocation: "Primary", pincode: "395002", defaultWeightKg: 0.3 },
};
const business = {
  legalName: "Sorath Watch (Placeholder) Pvt Ltd",
  gstin: "24ABCDE1234F1Z5", // sample/placeholder — replace with the real GSTIN
  stateCode: "24",
  address: "Sample Address, Ring Road, Surat, Gujarat 395002 (placeholder)",
  email: "care@sorathwatch.test",
  phone: "9876500000",
  grievanceOfficer: { name: "Grievance Officer (placeholder)", email: "grievance@sorathwatch.test", phone: "9876500001" },
};

let tenant = await Tenant.findOne({ slug: SLUG });
if (tenant) {
  await Tenant.updateOne({ _id: tenant._id }, { $set: { name: "Sorath Watch", business, settings } });
} else {
  tenant = await Tenant.create({ name: "Sorath Watch", slug: SLUG, business, settings });
}
const tenantId = String(tenant!._id);

await Domain.updateOne(
  { hostname: `${SLUG}.${env.PLATFORM_DOMAIN}` },
  { $setOnInsert: { tenantId: tenant!._id, kind: "subdomain", isPrimary: true }, $set: { status: "active" } },
  { upsert: true },
);
await Domain.updateOne(
  { hostname: `${SLUG}.localhost` },
  { $setOnInsert: { tenantId: tenant!._id, kind: "subdomain" }, $set: { status: "active" } },
  { upsert: true },
);

await runWithoutTenant("seed-sorath", () =>
  User.updateOne(
    { email: OWNER_EMAIL },
    {
      $setOnInsert: { tenantId: tenant!._id, email: OWNER_EMAIL, role: "owner" },
      $set: { name: "Sorath Owner", passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 12) },
    },
    { upsert: true },
  ),
);

// ---- Catalog ----
type Attrs = { strap: string; color: string; dial: string; lock: string; occasion: string[]; movement: string; gender: string };
type W = {
  title: string;
  cats: string[];
  brand: string;
  priceR: number;
  compareR: number | null;
  seed: string;
  feat?: boolean;
  colours: string[];
  a: Attrs;
  tags: string[];
};

const CATS = [
  { name: "Men's Watches", slug: "mens-watches", sortOrder: 1, seed: "sorath-cat-men" },
  { name: "Women's Watches", slug: "womens-watches", sortOrder: 2, seed: "sorath-cat-women" },
  { name: "Smart & Hybrid", slug: "smart-hybrid", sortOrder: 3, seed: "sorath-cat-smart" },
  { name: "Luxury", slug: "luxury", sortOrder: 4, seed: "sorath-cat-luxury" },
  { name: "Sports", slug: "sports", sortOrder: 5, seed: "sorath-cat-sports" },
  { name: "Ethnic & Festive", slug: "ethnic-festive", sortOrder: 6, seed: "sorath-cat-ethnic" },
];

const WATCHES: W[] = [
  {
    title: "Sorath Heritage Leather Automatic",
    cats: ["mens-watches", "luxury"],
    brand: "Sorath",
    priceR: 12499,
    compareR: 15999,
    seed: "sw-heritage",
    feat: true,
    colours: ["Brown", "Black"],
    a: {
      strap: "Leather",
      color: "Gold",
      dial: "Brown",
      lock: "Deployment",
      occasion: ["Formal", "Daily wear"],
      movement: "Automatic",
      gender: "Men",
    },
    tags: ["bestseller", "leather", "automatic"],
  },
  {
    title: "Sorath Classic Steel Chronograph",
    cats: ["mens-watches"],
    brand: "Sorath",
    priceR: 8999,
    compareR: 11999,
    seed: "sw-chrono",
    feat: true,
    colours: ["Silver", "Black"],
    a: {
      strap: "Stainless Steel",
      color: "Silver",
      dial: "Blue",
      lock: "Fold-over",
      occasion: ["Formal", "Daily wear"],
      movement: "Chronograph",
      gender: "Men",
    },
    tags: ["chronograph", "steel"],
  },
  {
    title: "Sorath Minimalist Mesh",
    cats: ["mens-watches", "womens-watches"],
    brand: "Sorath",
    priceR: 4299,
    compareR: 5499,
    seed: "sw-mesh",
    colours: ["Silver", "Rose Gold"],
    a: {
      strap: "Mesh",
      color: "Rose Gold",
      dial: "White",
      lock: "Magnetic",
      occasion: ["Daily wear", "Casual"],
      movement: "Quartz",
      gender: "Unisex",
    },
    tags: ["minimalist", "mesh", "unisex"],
  },
  {
    title: "Sorath Aurora Rose Gold",
    cats: ["womens-watches", "luxury"],
    brand: "Sorath",
    priceR: 7499,
    compareR: 9999,
    seed: "sw-aurora",
    feat: true,
    colours: ["Rose Gold"],
    a: {
      strap: "Stainless Steel",
      color: "Rose Gold",
      dial: "Rose Gold",
      lock: "Butterfly",
      occasion: ["Formal", "Ethnic"],
      movement: "Quartz",
      gender: "Women",
    },
    tags: ["rosegold", "gift"],
  },
  {
    title: "Sorath Petite Leather",
    cats: ["womens-watches"],
    brand: "Sorath",
    priceR: 3499,
    compareR: 4299,
    seed: "sw-petite",
    colours: ["Tan", "Black"],
    a: {
      strap: "Leather",
      color: "Gold",
      dial: "White",
      lock: "Buckle",
      occasion: ["Daily wear", "Casual"],
      movement: "Quartz",
      gender: "Women",
    },
    tags: ["leather", "petite"],
  },
  {
    title: "Sorath FieldPro NATO",
    cats: ["mens-watches", "sports"],
    brand: "Sorath",
    priceR: 3999,
    compareR: null,
    seed: "sw-field",
    colours: ["Green", "Black"],
    a: {
      strap: "NATO/Nylon",
      color: "Black",
      dial: "Green",
      lock: "Buckle",
      occasion: ["Casual", "Sports"],
      movement: "Quartz",
      gender: "Men",
    },
    tags: ["field", "nato", "rugged"],
  },
  {
    title: "Sorath Active Silicone Sport",
    cats: ["sports"],
    brand: "Sorath",
    priceR: 2499,
    compareR: 3299,
    seed: "sw-active",
    colours: ["Black", "Blue"],
    a: {
      strap: "Silicone",
      color: "Black",
      dial: "Black",
      lock: "Buckle",
      occasion: ["Sports", "Daily wear"],
      movement: "Quartz",
      gender: "Unisex",
    },
    tags: ["sport", "silicone", "waterproof"],
  },
  {
    title: "Sorath Pulse Smartwatch",
    cats: ["smart-hybrid", "sports"],
    brand: "Sorath",
    priceR: 5999,
    compareR: 7999,
    seed: "sw-pulse",
    feat: true,
    colours: ["Black", "Silver"],
    a: {
      strap: "Silicone",
      color: "Black",
      dial: "Black",
      lock: "Buckle",
      occasion: ["Sports", "Daily wear"],
      movement: "Quartz",
      gender: "Unisex",
    },
    tags: ["smart", "fitness", "amoled"],
  },
  {
    title: "Sorath Hybrid Connect",
    cats: ["smart-hybrid"],
    brand: "Sorath",
    priceR: 6999,
    compareR: null,
    seed: "sw-hybrid",
    colours: ["Silver", "Rose Gold"],
    a: {
      strap: "Mesh",
      color: "Silver",
      dial: "Silver",
      lock: "Magnetic",
      occasion: ["Daily wear", "Formal"],
      movement: "Quartz",
      gender: "Unisex",
    },
    tags: ["hybrid", "smart"],
  },
  {
    title: "Sorath Maharaja Gold Ethnic",
    cats: ["ethnic-festive", "luxury"],
    brand: "Sorath",
    priceR: 14999,
    compareR: 18999,
    seed: "sw-maharaja",
    feat: true,
    colours: ["Gold"],
    a: {
      strap: "Gold-plated",
      color: "Gold",
      dial: "White",
      lock: "Butterfly",
      occasion: ["Ethnic", "Formal"],
      movement: "Automatic",
      gender: "Men",
    },
    tags: ["festive", "gold", "gift"],
  },
  {
    title: "Sorath Rani Festive Bracelet",
    cats: ["ethnic-festive", "womens-watches"],
    brand: "Sorath",
    priceR: 5499,
    compareR: 6999,
    seed: "sw-rani",
    colours: ["Gold", "Rose Gold"],
    a: {
      strap: "Gold-plated",
      color: "Rose Gold",
      dial: "Rose Gold",
      lock: "Fold-over",
      occasion: ["Ethnic", "Formal"],
      movement: "Quartz",
      gender: "Women",
    },
    tags: ["festive", "bracelet", "gift"],
  },
  {
    title: "Sorath Monochrome Black",
    cats: ["mens-watches"],
    brand: "Sorath",
    priceR: 4799,
    compareR: null,
    seed: "sw-mono",
    colours: ["Black"],
    a: {
      strap: "Stainless Steel",
      color: "Black",
      dial: "Black",
      lock: "Fold-over",
      occasion: ["Formal", "Daily wear"],
      movement: "Quartz",
      gender: "Men",
    },
    tags: ["black", "steel"],
  },
  {
    title: "Sorath Azure Blue Diver",
    cats: ["sports", "mens-watches"],
    brand: "Sorath",
    priceR: 9499,
    compareR: 12499,
    seed: "sw-diver",
    feat: true,
    colours: ["Blue", "Silver"],
    a: {
      strap: "Stainless Steel",
      color: "Silver",
      dial: "Blue",
      lock: "Deployment",
      occasion: ["Sports", "Casual"],
      movement: "Automatic",
      gender: "Men",
    },
    tags: ["diver", "automatic", "200m"],
  },
  {
    title: "Sorath Everyday Tan Leather",
    cats: ["mens-watches"],
    brand: "Sorath",
    priceR: 2999,
    compareR: 3799,
    seed: "sw-everyday",
    colours: ["Tan"],
    a: {
      strap: "Leather",
      color: "Silver",
      dial: "White",
      lock: "Buckle",
      occasion: ["Daily wear", "Casual"],
      movement: "Quartz",
      gender: "Men",
    },
    tags: ["leather", "everyday"],
  },
  {
    title: "Sorath Lumen Rose Mesh",
    cats: ["womens-watches"],
    brand: "Sorath",
    priceR: 3899,
    compareR: 4999,
    seed: "sw-lumen",
    colours: ["Rose Gold"],
    a: {
      strap: "Mesh",
      color: "Rose Gold",
      dial: "White",
      lock: "Magnetic",
      occasion: ["Daily wear", "Formal"],
      movement: "Quartz",
      gender: "Women",
    },
    tags: ["rosegold", "mesh"],
  },
  {
    title: "Sorath Trail Green Silicone",
    cats: ["sports"],
    brand: "Sorath",
    priceR: 2199,
    compareR: null,
    seed: "sw-trail",
    colours: ["Green", "Black"],
    a: {
      strap: "Silicone",
      color: "Black",
      dial: "Green",
      lock: "Buckle",
      occasion: ["Sports", "Casual"],
      movement: "Quartz",
      gender: "Unisex",
    },
    tags: ["trail", "silicone"],
  },
  {
    title: "Sorath Executive Two-Tone",
    cats: ["mens-watches", "luxury"],
    brand: "Sorath",
    priceR: 10999,
    compareR: 13999,
    seed: "sw-exec",
    colours: ["Two-tone"],
    a: {
      strap: "Stainless Steel",
      color: "Two-tone",
      dial: "Silver",
      lock: "Butterfly",
      occasion: ["Formal", "Ethnic"],
      movement: "Automatic",
      gender: "Men",
    },
    tags: ["two-tone", "executive"],
  },
  {
    title: "Sorath Nova White Ceramic",
    cats: ["womens-watches", "luxury"],
    brand: "Sorath",
    priceR: 8499,
    compareR: null,
    seed: "sw-nova",
    colours: ["Silver", "Rose Gold"],
    a: {
      strap: "Stainless Steel",
      color: "Silver",
      dial: "White",
      lock: "Deployment",
      occasion: ["Formal", "Daily wear"],
      movement: "Quartz",
      gender: "Women",
    },
    tags: ["ceramic", "white"],
  },
  {
    title: "Sorath Cadet NATO Casual",
    cats: ["mens-watches", "sports"],
    brand: "Sorath",
    priceR: 1999,
    compareR: 2599,
    seed: "sw-cadet",
    colours: ["Green", "Blue"],
    a: {
      strap: "NATO/Nylon",
      color: "Silver",
      dial: "Black",
      lock: "Buckle",
      occasion: ["Casual", "Daily wear"],
      movement: "Quartz",
      gender: "Men",
    },
    tags: ["cadet", "nato", "budget"],
  },
  {
    title: "Sorath Solaris Gold Chronograph",
    cats: ["mens-watches", "luxury"],
    brand: "Sorath",
    priceR: 13499,
    compareR: 16999,
    seed: "sw-solaris",
    feat: true,
    colours: ["Gold", "Two-tone"],
    a: {
      strap: "Gold-plated",
      color: "Gold",
      dial: "Black",
      lock: "Fold-over",
      occasion: ["Formal", "Ethnic"],
      movement: "Chronograph",
      gender: "Men",
    },
    tags: ["gold", "chronograph", "luxury"],
  },
  {
    title: "Sorath Bloom Green Leather",
    cats: ["womens-watches"],
    brand: "Sorath",
    priceR: 3299,
    compareR: 3999,
    seed: "sw-bloom",
    colours: ["Green", "Tan"],
    a: {
      strap: "Leather",
      color: "Gold",
      dial: "Green",
      lock: "Buckle",
      occasion: ["Casual", "Ethnic"],
      movement: "Quartz",
      gender: "Women",
    },
    tags: ["green", "leather"],
  },
  {
    title: "Sorath Horizon Silver Automatic",
    cats: ["mens-watches", "luxury"],
    brand: "Sorath",
    priceR: 11499,
    compareR: null,
    seed: "sw-horizon",
    colours: ["Silver"],
    a: {
      strap: "Mesh",
      color: "Silver",
      dial: "Silver",
      lock: "Butterfly",
      occasion: ["Formal", "Daily wear"],
      movement: "Automatic",
      gender: "Men",
    },
    tags: ["silver", "automatic"],
  },
];

await runAsTenant(tenantId, async () => {
  // Rebuild the store's catalog deterministically on every run (tenant-scoped deletes).
  await Promise.all([Product.deleteMany({}), Category.deleteMany({}), Coupon.deleteMany({}), Page.deleteMany({})]);

  const catDocs = await Category.create(
    CATS.map((c, i) => ({ name: c.name, slug: c.slug, sortOrder: c.sortOrder, imageUrl: U(WATCH_IMAGES[(i * 3) % WATCH_IMAGES.length], 600, 600), isActive: true })),
  );
  const catId = (slug: string) => catDocs.find((c) => c.slug === slug)!._id;

  for (const w of WATCHES) {
    await Product.create({
      title: w.title,
      slug: w.seed,
      description: `${w.title}. ${w.a.movement} movement, ${w.a.strap.toLowerCase()} strap, ${w.a.dial.toLowerCase()} dial with a ${w.a.lock.toLowerCase()} clasp. Water-resistant. 24-month movement warranty. All prices inclusive of GST.`,
      brand: w.brand,
      categoryIds: w.cats.map(catId),
      images: [
        { url: prodImg(WATCHES.indexOf(w)), alt: w.title },
        { url: prodImg(WATCHES.indexOf(w) + 7), alt: `${w.title} — alternate view` },
      ],
      optionNames: ["Strap Colour"],
      variants: w.colours.map((c, i) => ({
        sku: `${w.seed.toUpperCase()}-${c.slice(0, 3).toUpperCase()}`,
        options: { "Strap Colour": c },
        pricePaise: w.priceR * 100,
        compareAtPaise: w.compareR ? w.compareR * 100 : null,
        stock: 25 - i * 5,
        weightKg: 0.25,
      })),
      hsn: "9102", // wrist watches
      gstRatePercent: 18,
      status: "active",
      isFeatured: !!w.feat,
      tags: w.tags,
      attributes: {
        strap: [w.a.strap],
        color: [w.a.color],
        dial: [w.a.dial],
        lock: [w.a.lock],
        occasion: w.a.occasion,
        movement: [w.a.movement],
        gender: [w.a.gender],
      },
      seo: {
        title: `${w.title} | Sorath Watch`,
        description: `Buy ${w.title} online. ${w.a.movement}, ${w.a.strap} strap. GST-inclusive pricing, COD available.`,
      },
    });
  }

  await Coupon.create([
    { code: "SORATH10", type: "percent", value: 10, minOrderPaise: 200000, maxDiscountPaise: 150000, isActive: true },
    { code: "FESTIVE500", type: "flat", value: 50000, minOrderPaise: 500000, isActive: true },
  ]);

  await Page.create([
    {
      title: "The Sorath Club",
      slug: "club",
      body: "The Sorath Club is our small way of saying thank you.\n\nSorath began with a single counter in Surat and a simple belief: a good watch should be honest, well made, and looked after for years — not just sold. The people who kept coming back became more than customers. They became the reason we do this.\n\nSo we started the Club. Join free with your first order and you're in — no points to chase, no fine print. Members get early access to new drops and sales, a complimentary first service, an extended warranty, priority support, and members-only festive offers.\n\nIt isn't a loyalty scheme. It's a circle of people who love a good watch, looked after a little better. Welcome to the Sorath Club.",
    },
    {
      title: "About Sorath Watch",
      slug: "about",
      body: "Sorath Watch began in Surat with a simple idea: a good watch should be honest, well made, and built to last — not just sold.\n\nWe bring together timepieces for every occasion — everyday leather and steel, dependable quartz, automatic and chronograph movements, sporty silicone, and dressier pieces for work and festive days. Every watch is chosen for its build and value, inspected before it ships, and backed by our warranty and easy-exchange promise.\n\nNo inflated MRPs and no pressure — just watches we would be glad to wear ourselves, delivered across India with cash on delivery, free shipping over ₹1,999, and a 7-day exchange.\n\nFrom a single counter to screens across the country, our promise hasn't changed: fair prices, careful selection, and dependable service long after the sale. Thank you for making us part of your everyday.\n\n— The Sorath Watch team",
    },
    {
      title: "Contact us",
      slug: "contact",
      body: "Customer care: care@sorathwatch.test • 9876500000 (placeholder). Mon–Sat, 10am–7pm IST.",
    },
    {
      title: "Shipping policy",
      slug: "shipping-policy",
      body: "Orders ship within 2 working days. Delivery in 3–7 days across India. Free shipping above ₹1,999.",
    },
    {
      title: "Returns & refunds",
      slug: "refund-policy",
      body: "7-day easy exchange on unused watches with tags and packaging. Refunds in 5–7 working days.",
    },
    {
      title: "Privacy policy",
      slug: "privacy-policy",
      body: "We use your details only to process and deliver your orders. (Placeholder — review for DPDP compliance.)",
    },
    { title: "Terms of service", slug: "terms", body: "By placing an order you agree to these terms. (Placeholder.)" },
  ]);
});

console.log(`Sorath Watch ready: http://${SLUG}.localhost:3000  (owner ${OWNER_EMAIL} / ${OWNER_PASSWORD})`);
console.log(`Seeded ${WATCHES.length} watches across ${CATS.length} categories.`);
await mongoose.disconnect();
