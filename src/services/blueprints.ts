import { Types } from "mongoose";
import { Category, Product, Page, Coupon } from "../models/catalog.js";
import { Tenant } from "../models/platform.js";
import { runAsTenant, runWithoutTenant } from "../db/tenantContext.js";

export type BlueprintKey = "fashion" | "grocery" | "general";

export interface BlueprintInfo {
  key: BlueprintKey;
  title: string;
  category: string;
  description: string;
  thumbnailUrl: string;
}

export const BLUEPRINTS: Record<BlueprintKey, BlueprintInfo> = {
  fashion: {
    key: "fashion",
    title: "D2C Fashion & Ethnic Wear",
    category: "Apparel & Accessories",
    description: "Tailored for clothing brands with size/color matrices, 12% GST slabs, wash care guides, and festival banner layouts.",
    thumbnailUrl: "https://images.unsplash.com/photo-1445205170230-053b83016050?w=600&auto=format&fit=crop&q=80",
  },
  grocery: {
    key: "grocery",
    title: "FMCG, Gourmet & Kirana",
    category: "Food & Staples",
    description: "Designed for organic food, staples and supermarkets with weight variants (500g/1kg), FSSAI disclosures, and 0-5% GST.",
    thumbnailUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e?w=600&auto=format&fit=crop&q=80",
  },
  general: {
    key: "general",
    title: "Modern D2C Tech & Lifestyle",
    category: "Electronics & Gadgets",
    description: "Sleek dark/tech layout for consumer electronics, audio gear, and lifestyle products with specifications and warranty tags.",
    thumbnailUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=600&auto=format&fit=crop&q=80",
  },
};

export async function applyBlueprint(tenantId: string, blueprintKey: BlueprintKey): Promise<void> {
  // Always execute tenant catalog seeding within runAsTenant to guarantee multi-tenant scoping!
  await runAsTenant(tenantId, async () => {
    if (blueprintKey === "fashion") {
      await seedFashion(tenantId);
    } else if (blueprintKey === "grocery") {
      await seedGrocery(tenantId);
    } else {
      await seedGeneral(tenantId);
    }
  });
}

async function seedFashion(tenantId: string) {
  // 1. Categories
  const ethnicCat = await Category.create({
    name: "Women's Ethnic",
    slug: "womens-ethnic",
    sortOrder: 1,
    imageUrl: "https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=600&auto=format&fit=crop&q=80",
  });
  const mensCat = await Category.create({
    name: "Men's Casuals",
    slug: "mens-casuals",
    sortOrder: 2,
    imageUrl: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=600&auto=format&fit=crop&q=80",
  });
  const footwearCat = await Category.create({
    name: "Footwear & Leather",
    slug: "footwear",
    sortOrder: 3,
    imageUrl: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=600&auto=format&fit=crop&q=80",
  });

  // 2. Products with Variants
  await Product.create({
    title: "Handcrafted Chanderi Silk Kurta Set",
    slug: "handcrafted-chanderi-silk-kurta-set",
    description: "Exquisite handwoven Chanderi silk kurta paired with organza dupatta and palazzo. Features delicate zari embroidery along the neckline.",
    brand: "Aura Silks",
    categoryIds: [ethnicCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=800&auto=format&fit=crop&q=80", alt: "Silk Kurta Front" },
      { url: "https://images.unsplash.com/photo-1583391733956-3750e0ff4e8b?w=800&auto=format&fit=crop&q=80", alt: "Embroidery Detail" },
    ],
    optionNames: ["Size", "Color"],
    variants: [
      { sku: "FSH-KRT-M-RED", options: { Size: "M", Color: "Ruby Red" }, pricePaise: 249900, compareAtPaise: 349900, stock: 25 },
      { sku: "FSH-KRT-L-RED", options: { Size: "L", Color: "Ruby Red" }, pricePaise: 249900, compareAtPaise: 349900, stock: 30 },
      { sku: "FSH-KRT-XL-RED", options: { Size: "XL", Color: "Ruby Red" }, pricePaise: 249900, compareAtPaise: 349900, stock: 15 },
      { sku: "FSH-KRT-M-GLD", options: { Size: "M", Color: "Mustard Gold" }, pricePaise: 249900, compareAtPaise: 349900, stock: 20 },
      { sku: "FSH-KRT-L-GLD", options: { Size: "L", Color: "Mustard Gold" }, pricePaise: 249900, compareAtPaise: 349900, stock: 18 },
    ],
    hsn: "6204",
    gstRatePercent: 12,
    status: "active",
    isFeatured: true,
    tags: ["festive", "ethnic", "silk", "kurta"],
  });

  await Product.create({
    title: "Pure Linen Slim Fit Casual Shirt",
    slug: "pure-linen-slim-fit-casual-shirt",
    description: "Breathable 100% French flax linen shirt. Tailored for comfort in warm Indian weather with coconut shell buttons.",
    brand: "Aura Casuals",
    categoryIds: [mensCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=800&auto=format&fit=crop&q=80", alt: "Linen Shirt Front" },
    ],
    optionNames: ["Size", "Color"],
    variants: [
      { sku: "FSH-SHRT-M-WHT", options: { Size: "M", Color: "White" }, pricePaise: 129900, compareAtPaise: 179900, stock: 40 },
      { sku: "FSH-SHRT-L-WHT", options: { Size: "L", Color: "White" }, pricePaise: 129900, compareAtPaise: 179900, stock: 35 },
      { sku: "FSH-SHRT-M-BLU", options: { Size: "M", Color: "Navy Blue" }, pricePaise: 129900, compareAtPaise: 179900, stock: 25 },
    ],
    hsn: "6205",
    gstRatePercent: 12,
    status: "active",
    isFeatured: true,
    tags: ["linen", "mens", "summer", "shirts"],
  });

  await Product.create({
    title: "Handmade Classic Leather Loafers",
    slug: "handmade-classic-leather-loafers",
    description: "Full-grain genuine leather loafers with cushioned memory foam insole. Handcrafted by heritage artisans.",
    brand: "Aura Leather",
    categoryIds: [footwearCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1533867617858-e7b97e060509?w=800&auto=format&fit=crop&q=80", alt: "Loafers Front" },
    ],
    optionNames: ["Size", "Color"],
    variants: [
      { sku: "FSH-LFR-08-BRN", options: { Size: "UK 8", Color: "Tan Brown" }, pricePaise: 319900, compareAtPaise: 449900, stock: 12 },
      { sku: "FSH-LFR-09-BRN", options: { Size: "UK 9", Color: "Tan Brown" }, pricePaise: 319900, compareAtPaise: 449900, stock: 18 },
      { sku: "FSH-LFR-10-BRN", options: { Size: "UK 10", Color: "Tan Brown" }, pricePaise: 319900, compareAtPaise: 449900, stock: 10 },
    ],
    hsn: "6403",
    gstRatePercent: 18,
    status: "active",
    isFeatured: false,
    tags: ["shoes", "leather", "formal", "loafers"],
  });

  // 3. Coupons
  await Coupon.create({
    code: "FIRST10",
    type: "percent",
    value: 10,
    minOrderPaise: 99900,
    isActive: true,
  });
  await Coupon.create({
    code: "FESTIVE500",
    type: "flat",
    value: 50000,
    minOrderPaise: 299900,
    isActive: true,
  });

  // 4. Policy Pages
  await seedStandardPages();

  // 5. Update Tenant Styling
  await runWithoutTenant("seed-theme", () =>
    Tenant.updateOne(
      { _id: tenantId },
      {
        $set: {
          "settings.theme": "fashion",
          "settings.colors": { primary: "#7c2d12", accent: "#d97706", background: "#fefefe", text: "#1c1917" },
          "settings.font": "Plus Jakarta Sans",
          "settings.banners": [
            {
              imageUrl: "https://images.unsplash.com/photo-1445205170230-053b83016050?w=1400&auto=format&fit=crop&q=80",
              title: "Festive Elegance Collection",
              subtitle: "Handcrafted ethnic silhouettes in pure silks and breathable linens.",
              link: "/categories/womens-ethnic",
            },
          ],
        },
      },
    ),
  );
}

async function seedGrocery(tenantId: string) {
  // 1. Categories
  const staplesCat = await Category.create({
    name: "Organic Staples & Grains",
    slug: "organic-staples",
    sortOrder: 1,
    imageUrl: "https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600&auto=format&fit=crop&q=80",
  });
  const dryFruitsCat = await Category.create({
    name: "Dry Fruits & Nuts",
    slug: "dry-fruits-nuts",
    sortOrder: 2,
    imageUrl: "https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=600&auto=format&fit=crop&q=80",
  });
  const beveragesCat = await Category.create({
    name: "Teas & Artisan Coffee",
    slug: "teas-coffee",
    sortOrder: 3,
    imageUrl: "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=600&auto=format&fit=crop&q=80",
  });

  // 2. Products
  await Product.create({
    title: "Cold-Pressed Virgin Mustard Oil (Wood-Pressed)",
    slug: "cold-pressed-virgin-mustard-oil",
    description: "Traditional Kolhu wood-pressed kachi ghani mustard oil. Unrefined, unbleached, retaining 100% natural aroma and antioxidants. FSSAI Certified.",
    brand: "Prakriti Organics",
    categoryIds: [staplesCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=800&auto=format&fit=crop&q=80", alt: "Mustard Oil Bottle" },
    ],
    optionNames: ["Volume"],
    variants: [
      { sku: "GRO-OIL-1L", options: { Volume: "1 Litre" }, pricePaise: 24000, compareAtPaise: 28000, stock: 50 },
      { sku: "GRO-OIL-5L", options: { Volume: "5 Litres" }, pricePaise: 110000, compareAtPaise: 130000, stock: 20 },
    ],
    hsn: "1514",
    gstRatePercent: 5,
    status: "active",
    isFeatured: true,
    tags: ["organic", "oil", "cooking", "cold-pressed"],
  });

  await Product.create({
    title: "Premium California Whole Almonds (Badam Giri)",
    slug: "premium-california-whole-almonds",
    description: "Hand-sorted, jumbo sized crisp almonds. High in protein, dietary fibre and vitamin E. Vacuum sealed for maximum freshness.",
    brand: "Prakriti Organics",
    categoryIds: [dryFruitsCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1508061252445-5350f3ab0a55?w=800&auto=format&fit=crop&q=80", alt: "Almonds Bowl" },
    ],
    optionNames: ["Weight"],
    variants: [
      { sku: "GRO-ALM-500G", options: { Weight: "500 Grams" }, pricePaise: 49900, compareAtPaise: 59900, stock: 60 },
      { sku: "GRO-ALM-1KG", options: { Weight: "1 Kilogram" }, pricePaise: 94900, compareAtPaise: 115000, stock: 40 },
    ],
    hsn: "0802",
    gstRatePercent: 12,
    status: "active",
    isFeatured: true,
    tags: ["dry-fruits", "almonds", "healthy", "nuts"],
  });

  await Product.create({
    title: "Single-Estate Darjeeling First Flush Black Tea",
    slug: "single-estate-darjeeling-first-flush-black-tea",
    description: "Direct from the misty hills of Darjeeling. Delicate muscatel character with champagne floral notes.",
    brand: "Prakriti Organics",
    categoryIds: [beveragesCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80", alt: "Tea Leaves" },
    ],
    optionNames: ["Pack Size"],
    variants: [
      { sku: "GRO-TEA-100G", options: { "Pack Size": "100 Grams Tin" }, pricePaise: 45000, compareAtPaise: 55000, stock: 35 },
      { sku: "GRO-TEA-250G", options: { "Pack Size": "250 Grams Tin" }, pricePaise: 99000, compareAtPaise: 125000, stock: 25 },
    ],
    hsn: "0902",
    gstRatePercent: 5,
    status: "active",
    isFeatured: true,
    tags: ["tea", "darjeeling", "organic", "beverages"],
  });

  // 3. Coupons
  await Coupon.create({
    code: "FREESHIP",
    type: "flat",
    value: 4900,
    minOrderPaise: 49900,
    isActive: true,
  });

  // 4. Policy Pages
  await seedStandardPages();

  // 5. Update Theme
  await runWithoutTenant("seed-theme", () =>
    Tenant.updateOne(
      { _id: tenantId },
      {
        $set: {
          "settings.theme": "grocery",
          "settings.colors": { primary: "#065f46", accent: "#10b981", background: "#ffffff", text: "#111827" },
          "settings.font": "Inter",
          "settings.banners": [
            {
              imageUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e?w=1400&auto=format&fit=crop&q=80",
              title: "Farm Fresh & 100% Organic",
              subtitle: "Pure certified organic cold-pressed oils, grains and handpicked dry fruits.",
              link: "/categories/organic-staples",
            },
          ],
        },
      },
    ),
  );
}

async function seedGeneral(tenantId: string) {
  // 1. Categories
  const audioCat = await Category.create({
    name: "Audio & Acoustics",
    slug: "audio-acoustics",
    sortOrder: 1,
    imageUrl: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=600&auto=format&fit=crop&q=80",
  });
  const powerCat = await Category.create({
    name: "Fast Chargers & Power",
    slug: "chargers-power",
    sortOrder: 2,
    imageUrl: "https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=600&auto=format&fit=crop&q=80",
  });
  const wearablesCat = await Category.create({
    name: "Smart Wearables",
    slug: "smart-wearables",
    sortOrder: 3,
    imageUrl: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&auto=format&fit=crop&q=80",
  });

  // 2. Products
  await Product.create({
    title: "Pro ANC True Wireless Earbuds with Spatial Audio",
    slug: "pro-anc-true-wireless-earbuds",
    description: "Industry-leading 42dB Hybrid Active Noise Cancellation, 11mm titanium drivers, 36-hour total battery life with fast Qi wireless charging case.",
    brand: "Volt Audio",
    categoryIds: [audioCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800&auto=format&fit=crop&q=80", alt: "Earbuds Front" },
    ],
    optionNames: ["Color"],
    variants: [
      { sku: "TECH-TWS-BLK", options: { Color: "Matte Black" }, pricePaise: 299900, compareAtPaise: 499900, stock: 45 },
      { sku: "TECH-TWS-WHT", options: { Color: "Glacier White" }, pricePaise: 299900, compareAtPaise: 499900, stock: 30 },
    ],
    hsn: "8518",
    gstRatePercent: 18,
    status: "active",
    isFeatured: true,
    tags: ["tws", "earbuds", "anc", "audio", "wireless"],
  });

  await Product.create({
    title: "65W GaN Dual USB-C Ultra Fast Charger",
    slug: "65w-gan-dual-usb-c-fast-charger",
    description: "Next-gen Gallium Nitride (GaN) technology in a pocket-sized form factor. Charges laptops, tablets and phones simultaneously at full speed.",
    brand: "Volt Power",
    categoryIds: [powerCat._id],
    images: [
      { url: "https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=800&auto=format&fit=crop&q=80", alt: "GaN Charger" },
    ],
    optionNames: ["Plug Type"],
    variants: [
      { sku: "TECH-GAN-IN", options: { "Plug Type": "Indian 2-Pin" }, pricePaise: 149900, compareAtPaise: 229900, stock: 70 },
    ],
    hsn: "8504",
    gstRatePercent: 18,
    status: "active",
    isFeatured: true,
    tags: ["charger", "gan", "fast-charging", "power"],
  });

  // 3. Coupons
  await Coupon.create({
    code: "LAUNCH500",
    type: "flat",
    value: 50000,
    minOrderPaise: 199900,
    isActive: true,
  });

  // 4. Policy Pages
  await seedStandardPages();

  // 5. Update Theme
  await runWithoutTenant("seed-theme", () =>
    Tenant.updateOne(
      { _id: tenantId },
      {
        $set: {
          "settings.theme": "general",
          "settings.colors": { primary: "#1e3a8a", accent: "#3b82f6", background: "#ffffff", text: "#0f172a" },
          "settings.font": "Figtree",
          "settings.banners": [
            {
              imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1400&auto=format&fit=crop&q=80",
              title: "Next-Gen Audio & Charging",
              subtitle: "Engineered for pure acoustics and ultra-fast GaN charging capabilities.",
              link: "/categories/audio-acoustics",
            },
          ],
        },
      },
    ),
  );
}

async function seedStandardPages() {
  await Page.create({
    title: "Shipping & Delivery Policy",
    slug: "shipping-policy",
    body: `<h2>Shipping & Delivery Information</h2>
<p>We partner with premier courier networks (BlueDart, Delhivery, DTDC) to deliver across 19,000+ Indian PIN codes.</p>
<ul>
  <li><strong>Processing Time:</strong> Orders are processed and dispatched within 24-48 hours.</li>
  <li><strong>Standard Delivery:</strong> Delivered within 3-5 business days across major metro cities, and 5-7 business days for regional hubs.</li>
  <li><strong>Order Tracking:</strong> A live tracking link via SMS and WhatsApp is shared immediately upon courier dispatch.</li>
</ul>`,
    isPublished: true,
  });

  await Page.create({
    title: "7-Day Return & Refund Policy",
    slug: "return-policy",
    body: `<h2>Hassle-Free 7-Day Returns</h2>
<p>If you are not completely satisfied with your purchase, we offer a 7-day doorstep return or replacement from the date of delivery.</p>
<ul>
  <li>Products must be unused, in original packaging with tags intact.</li>
  <li>To initiate a return, contact our support team with your Order ID.</li>
  <li>Prepaid refunds are credited back to the original source payment method within 3-5 banking days.</li>
</ul>`,
    isPublished: true,
  });

  await Page.create({
    title: "Terms of Service",
    slug: "terms",
    body: `<h2>Terms & Conditions</h2>
<p>Welcome to our online store. By accessing and placing an order, you agree to our terms and conditions. All orders placed are subject to stock availability and confirmation of payment.</p>`,
    isPublished: true,
  });

  await Page.create({
    title: "Privacy Policy",
    slug: "privacy-policy",
    body: `<h2>Privacy Policy</h2>
<p>We respect your privacy. Customer phone numbers and addresses collected during checkout are solely used for order fulfillment, delivery tracking, and essential communication. We never sell your personal data to third parties.</p>`,
    isPublished: true,
  });
}
