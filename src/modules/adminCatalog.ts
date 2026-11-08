import { z } from "zod";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { moduleFor, slugify, escapeRegex } from "./_shared.js";
import { Category, Product, Coupon, Page } from "../models/catalog.js";
import { idParams, pagination } from "../http/route.js";
import { notFound, badRequest } from "../lib/errors.js";
import { requireTenantId } from "../db/tenantContext.js";
import { presignUpload } from "../integrations/storage/s3.js";
import { toPaise } from "../lib/money.js";

const { router, add } = moduleFor("Catalog", "/api/v1/admin");
export default router;

// ---------- Categories ----------
const categoryBody = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  parentId: z.string().nullable().optional(),
  imageUrl: z.string().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

add({ method: "get", path: "/categories", summary: "List categories", auth: "merchant", handler: () => Category.find().sort({ sortOrder: 1, name: 1 }).lean() });
add({
  method: "post", path: "/categories", summary: "Create category", auth: "merchant", body: categoryBody,
  handler: ({ body }) => Category.create({ ...body, slug: slugify(body.slug || body.name) }),
});
add({
  method: "patch", path: "/categories/:id", summary: "Update category", auth: "merchant", params: idParams, body: categoryBody.partial(),
  handler: async ({ params, body }) => {
    if (body.slug) body.slug = slugify(body.slug);
    const c = await Category.findByIdAndUpdate(params.id, { $set: body }, { new: true }).lean();
    if (!c) throw notFound("Category");
    return c;
  },
});
add({
  method: "delete", path: "/categories/:id", summary: "Delete category", auth: "merchant", params: idParams,
  handler: async ({ params }) => {
    await Product.updateMany({ categoryIds: params.id }, { $pull: { categoryIds: params.id } });
    await Category.deleteOne({ _id: params.id });
    return { ok: true };
  },
});

// ---------- Products ----------
const variantBody = z.object({
  _id: z.string().optional(),
  sku: z.string().min(1),
  options: z.record(z.string(), z.string()).default({}),
  pricePaise: z.number().int().min(0),
  compareAtPaise: z.number().int().min(0).nullable().optional(),
  stock: z.number().int().min(0).default(0),
  weightKg: z.number().positive().nullable().optional(),
  imageUrl: z.string().optional(),
});
const productBody = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  description: z.string().default(""),
  brand: z.string().optional(),
  categoryIds: z.array(z.string()).default([]),
  images: z.array(z.object({ url: z.string(), alt: z.string().optional() })).default([]),
  optionNames: z.array(z.string()).default([]),
  variants: z.array(variantBody).min(1, "Add at least one variant"),
  hsn: z.string().optional(),
  gstRatePercent: z.number().min(0).max(40).default(5),
  status: z.enum(["draft", "active", "archived"]).default("active"),
  isFeatured: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
});

add({
  method: "get", path: "/products", summary: "List products", auth: "merchant",
  query: pagination.extend({ q: z.string().optional(), status: z.enum(["draft", "active", "archived"]).optional(), categoryId: z.string().optional(), lowStock: z.coerce.boolean().optional() }),
  handler: async ({ query }) => {
    const filter: any = {};
    if (query.q) filter.$or = [{ title: new RegExp(escapeRegex(query.q), "i") }, { "variants.sku": new RegExp(escapeRegex(query.q), "i") }];
    if (query.status) filter.status = query.status;
    if (query.categoryId) filter.categoryIds = query.categoryId;
    if (query.lowStock) filter["variants.stock"] = { $lte: 5 };
    const [items, total] = await Promise.all([
      Product.find(filter).sort({ updatedAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      Product.countDocuments(filter),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  },
});
add({
  method: "get", path: "/products/:id", summary: "Get product", auth: "merchant", params: idParams,
  handler: async ({ params }) => (await Product.findById(params.id).lean()) ?? Promise.reject(notFound("Product")),
});
add({
  method: "post", path: "/products", summary: "Create product", auth: "merchant", body: productBody,
  handler: ({ body }) => Product.create({ ...body, slug: slugify(body.slug || body.title) }),
});
add({
  method: "put", path: "/products/:id", summary: "Replace product", auth: "merchant", params: idParams, body: productBody,
  handler: async ({ params, body }) => {
    const p = await Product.findById(params.id);
    if (!p) throw notFound("Product");
    p.set({ ...body, slug: slugify(body.slug || body.title) });
    await p.save();
    return p;
  },
});
add({
  method: "patch", path: "/products/:id/stock", summary: "Set stock for variants", auth: "merchant", params: idParams,
  body: z.object({ updates: z.array(z.object({ variantId: z.string(), stock: z.number().int().min(0) })) }),
  handler: async ({ params, body }) => {
    for (const u of body.updates) await Product.updateOne({ _id: params.id, "variants._id": u.variantId }, { $set: { "variants.$.stock": u.stock } });
    return Product.findById(params.id).lean();
  },
});
add({
  method: "delete", path: "/products/:id", summary: "Archive product", auth: "merchant", params: idParams,
  handler: async ({ params }) => {
    await Product.updateOne({ _id: params.id }, { $set: { status: "archived" } });
    return { ok: true };
  },
});

/**
 * CSV import. Columns: title, slug, description, category, sku, option1_name, option1_value,
 * option2_name, option2_value, option3_name, option3_value, price, compare_at_price, stock, weight_kg, hsn, gst_rate, image_url, status
 * Rows with the same slug (or title) become variants of one product.
 */
add({
  method: "post", path: "/products/import", summary: "Bulk import products from CSV text", auth: "merchant",
  body: z.object({ csv: z.string().min(1).max(5_000_000) }),
  handler: async ({ body }) => {
    const rows: Record<string, string>[] = parseCsv(body.csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
    });
    if (!rows.length) throw badRequest("The CSV has no rows");

    const groups = new Map<string, Record<string, string>[]>();
    for (const r of rows) {
      const key = slugify(r.slug || r.title || "");
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }

    const categories = new Map((await Category.find().lean()).map((c) => [c.name.toLowerCase(), c._id]));
    let created = 0;
    let updated = 0;
    const errors: { row: string; message: string }[] = [];

    const cleanNumber = (val: string | undefined): number => {
      if (!val) return NaN;
      const cleaned = val.replace(/[^\d.]/g, "");
      return cleaned ? Number(cleaned) : NaN;
    };

    for (const [slug, group] of groups) {
      try {
        const first = group[0]!;
        let catId = first.category ? categories.get(first.category.toLowerCase()) : undefined;
        if (first.category && !catId) {
          const c = await Category.create({ name: first.category, slug: slugify(first.category) });
          catId = c._id;
          categories.set(first.category.toLowerCase(), c._id);
        }

        const optionNames = Array.from(
          new Set(
            group.flatMap((r) => [r.option1_name, r.option2_name, r.option3_name].filter(Boolean) as string[])
          )
        );

        const variants = group.map((r) => {
          const rawPrice = cleanNumber(r.price);
          const rawCompare = cleanNumber(r.compare_at_price);
          const variantImages = (r.image_url ? r.image_url.split(/[\s,;|]+/) : [])
            .map((u) => u.trim())
            .filter((u) => /^https?:\/\//i.test(u));

          const options: Record<string, string> = {};
          if (r.option1_name && r.option1_value) options[r.option1_name] = r.option1_value;
          if (r.option2_name && r.option2_value) options[r.option2_name] = r.option2_value;
          if (r.option3_name && r.option3_value) options[r.option3_name] = r.option3_value;

          return {
            sku: r.sku || `${slug}-${Math.random().toString(36).slice(2, 7)}`,
            options,
            pricePaise: toPaise(rawPrice),
            compareAtPaise: !Number.isNaN(rawCompare) ? toPaise(rawCompare) : null,
            stock: parseInt((r.stock || "0").replace(/[^\d-]/g, "") || "0", 10),
            weightKg: !Number.isNaN(cleanNumber(r.weight_kg)) ? cleanNumber(r.weight_kg) : null,
            imageUrl: variantImages[0] || undefined,
          };
        });

        if (variants.some((v) => Number.isNaN(v.pricePaise))) {
          throw new Error("Price is missing or invalid in one or more variants");
        }

        // Deduplicate all images across variants in order
        const allImages = Array.from(
          new Set(
            group
              .flatMap((r) => (r.image_url ? r.image_url.split(/[\s,;|]+/) : []))
              .map((u) => u.trim())
              .filter((u) => /^https?:\/\//i.test(u))
          )
        ).map((url) => ({ url }));

        const gstRateClean = cleanNumber(first.gst_rate);
        const doc = {
          title: first.title,
          slug,
          description: first.description ?? "",
          categoryIds: catId ? [catId] : [],
          images: allImages,
          optionNames,
          variants,
          hsn: first.hsn || undefined,
          gstRatePercent: !Number.isNaN(gstRateClean) ? gstRateClean : 5,
          status: (first.status as any) || "active",
        };

        const existing = await Product.findOne({ slug });
        if (existing) {
          existing.set(doc);
          await existing.save();
          updated++;
        } else {
          await Product.create(doc);
          created++;
        }
      } catch (e: any) {
        errors.push({ row: slug, message: e.message });
      }
    }
    return { created, updated, errors };
  },
});

add({
  method: "post", path: "/uploads", summary: "Get a presigned URL to upload an image", auth: "merchant",
  body: z.object({ folder: z.enum(["products", "branding", "categories"]), contentType: z.string() }),
  handler: ({ body }) => presignUpload(requireTenantId(), body.folder, body.contentType),
});

// Local file upload endpoint when S3 is not configured in local environment
router.put("/uploads/local/*key", express.raw({ type: "*/*", limit: "10mb" }), async (req, res) => {
  try {
    const rawKey = Array.isArray(req.params.key)
      ? req.params.key.join("/")
      : typeof req.params.key === "string"
      ? req.params.key
      : "";
    const key = decodeURIComponent(rawKey);
    if (!key || key.includes("..") || path.isAbsolute(key)) {
      return res.status(400).json({ error: { code: "invalid_key", message: "Invalid file key" } });
    }
    const uploadsDir = path.resolve(process.cwd(), "uploads");
    const filePath = path.resolve(uploadsDir, key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, req.body);
    res.status(200).send("OK");
  } catch (err: any) {
    res.status(500).json({ error: { code: "upload_failed", message: err.message || "Upload failed" } });
  }
});

// ---------- Coupons ----------
const couponBody = z.object({
  code: z.string().min(3).max(30),
  type: z.enum(["percent", "flat"]),
  value: z.number().positive(),
  minOrderPaise: z.number().int().min(0).default(0),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().default(true),
});
add({ method: "get", path: "/coupons", summary: "List coupons", auth: "merchant", handler: () => Coupon.find().sort({ createdAt: -1 }).lean() });
add({ method: "post", path: "/coupons", summary: "Create coupon", auth: "merchant", body: couponBody, handler: ({ body }) => Coupon.create(body) });
add({
  method: "patch", path: "/coupons/:id", summary: "Update coupon", auth: "merchant", params: idParams, body: couponBody.partial(),
  handler: async ({ params, body }) => (await Coupon.findByIdAndUpdate(params.id, { $set: body }, { new: true }).lean()) ?? Promise.reject(notFound("Coupon")),
});
add({ method: "delete", path: "/coupons/:id", summary: "Delete coupon", auth: "merchant", params: idParams, handler: async ({ params }) => { await Coupon.deleteOne({ _id: params.id }); return { ok: true }; } });

// ---------- Static pages ----------
const pageBody = z.object({ title: z.string().min(1), slug: z.string().optional(), body: z.string().default(""), isPublished: z.boolean().default(true) });
add({ method: "get", path: "/pages", summary: "List pages", auth: "merchant", handler: () => Page.find().sort({ title: 1 }).lean() });
add({ method: "post", path: "/pages", summary: "Create page", auth: "merchant", body: pageBody, handler: ({ body }) => Page.create({ ...body, slug: slugify(body.slug || body.title) }) });
add({
  method: "patch", path: "/pages/:id", summary: "Update page", auth: "merchant", params: idParams, body: pageBody.partial(),
  handler: async ({ params, body }) => (await Page.findByIdAndUpdate(params.id, { $set: { ...body, ...(body.slug ? { slug: slugify(body.slug) } : {}) } }, { new: true }).lean()) ?? Promise.reject(notFound("Page")),
});
add({ method: "delete", path: "/pages/:id", summary: "Delete page", auth: "merchant", params: idParams, handler: async ({ params }) => { await Page.deleteOne({ _id: params.id }); return { ok: true }; } });
