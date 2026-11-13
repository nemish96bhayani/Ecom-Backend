import { z } from "zod";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { moduleFor, slugify, slugOrId, escapeRegex, sentKeys, queryBool, clearableDate } from "./_shared.js";
import { Category, Product, Coupon, Page } from "../models/catalog.js";
import { idParams, objectId, pagination } from "../http/route.js";
import { notFound, badRequest } from "../lib/errors.js";
import { requireTenantId } from "../db/tenantContext.js";
import { merchantGuard } from "../middleware/guards.js";
import { env } from "../config/env.js";
import { presignUpload } from "../integrations/storage/s3.js";
import { parseImportCsv, groupImportRows, planImportProduct } from "../services/csvImport.js";

const { router, add } = moduleFor("Catalog", "/api/v1/admin");
export default router;

// ---------- Categories ----------
const categoryBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().max(120).optional(),
  parentId: objectId.nullable().optional(),
  imageUrl: z.string().max(2000).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

add({ method: "get", path: "/categories", summary: "List categories", auth: "merchant", handler: () => Category.find().sort({ sortOrder: 1, name: 1 }).lean() });
add({
  method: "post", path: "/categories", summary: "Create category", auth: "merchant", body: categoryBody,
  handler: ({ body }) => Category.create({ ...body, slug: slugify(body.slug || "") || slugOrId(body.name) }),
});
add({
  method: "patch", path: "/categories/:id", summary: "Update category", auth: "merchant", params: idParams, body: categoryBody.partial(),
  handler: async ({ params, body, req }) => {
    const patch = sentKeys(body, req.body);
    // An empty (or symbols-only) slug means "keep the current one", not "clear it".
    if ("slug" in patch) {
      const slug = slugify(patch.slug ?? "");
      if (slug) patch.slug = slug;
      else delete patch.slug;
    }
    const c = await Category.findByIdAndUpdate(params.id, { $set: patch }, { new: true }).lean();
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
  _id: objectId.optional(),
  sku: z.string().trim().min(1).max(64),
  options: z.record(z.string(), z.string()).default({}),
  pricePaise: z.number().int().min(0),
  compareAtPaise: z.number().int().min(0).nullable().optional(),
  // Optional on PUT: when omitted for an existing variant its current stock is kept (orders may have changed it).
  stock: z.number().int().min(0).optional(),
  weightKg: z.number().positive().nullable().optional(),
  imageUrl: z.string().max(2000).optional(),
});
const productBody = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().max(120).optional(),
  description: z.string().max(20_000).default(""),
  brand: z.string().max(120).optional(),
  categoryIds: z.array(objectId).max(50).default([]),
  images: z.array(z.object({ url: z.string().max(2000), alt: z.string().max(300).optional() })).max(50).default([]),
  optionNames: z.array(z.string().max(50)).max(3).default([]),
  variants: z.array(variantBody).min(1, "Add at least one variant").max(250),
  hsn: z.string().optional(),
  gstRatePercent: z.number().min(0).max(40).default(5),
  status: z.enum(["draft", "active", "archived"]).default("active"),
  isFeatured: z.boolean().default(false),
  tags: z.array(z.string().max(50)).max(50).default([]),
  attributes: z.record(z.string(), z.array(z.string())).optional(),
  seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
});

add({
  method: "get", path: "/products", summary: "List products", auth: "merchant",
  query: pagination.extend({ q: z.string().optional(), status: z.enum(["draft", "active", "archived"]).optional(), categoryId: objectId.optional(), lowStock: queryBool.optional() }),
  handler: async ({ query }) => {
    const filter: any = {};
    if (query.q) filter.$or = [{ title: new RegExp(escapeRegex(query.q), "i") }, { "variants.sku": new RegExp(escapeRegex(query.q), "i") }];
    if (query.status) filter.status = query.status;
    if (query.categoryId) filter.categoryIds = query.categoryId;
    if (query.lowStock) filter["variants.stock"] = { $lte: 5 };
    const [items, total] = await Promise.all([
      Product.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
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
  handler: ({ body }) =>
    Product.create({ ...body, variants: body.variants.map((v) => ({ ...v, stock: v.stock ?? 0 })), slug: slugify(body.slug || "") || slugOrId(body.title) }),
});
add({
  method: "put", path: "/products/:id", summary: "Replace product", auth: "merchant", params: idParams, body: productBody,
  handler: async ({ params, body }) => {
    const p = await Product.findById(params.id);
    if (!p) throw notFound("Product");
    const stockById = new Map(p.variants.map((v) => [String(v._id), v.stock ?? 0]));
    const variants = body.variants.map((v) => ({ ...v, stock: v.stock ?? (v._id ? stockById.get(v._id) : undefined) ?? 0 }));
    p.set({ ...body, variants, slug: slugify(body.slug || "") || slugify(body.title) || p.slug });
    await p.save();
    return p;
  },
});
add({
  method: "patch", path: "/products/:id/stock", summary: "Set stock for variants", auth: "merchant", params: idParams,
  body: z.object({ updates: z.array(z.object({ variantId: objectId, stock: z.number().int().min(0) })).max(250) }),
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
    const { rows, columns } = parseImportCsv(body.csv);
    const { groups, skipped } = groupImportRows(rows);

    const categories = new Map((await Category.find().lean()).map((c) => [c.name.toLowerCase(), c._id]));
    let created = 0;
    let updated = 0;
    const errors: { row: string; message: string }[] = [...skipped];

    for (const [slug, group] of groups) {
      try {
        const first = group[0]!;
        let catId = first.category ? categories.get(first.category.toLowerCase()) : undefined;
        if (first.category && !catId) {
          const c = await Category.create({ name: first.category, slug: slugOrId(first.category) });
          catId = c._id;
          categories.set(first.category.toLowerCase(), c._id);
        }

        const existing = await Product.findOne({ slug });
        if (existing) {
          existing.set(planImportProduct(slug, group, columns, existing.toObject(), catId));
          await existing.save();
          updated++;
        } else {
          await Product.create(planImportProduct(slug, group, columns, null, catId));
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

// Local file upload fallback for development only. Requires merchant auth, is tenant-scoped,
// and is never registered in production or when S3 is configured.
if (env.NODE_ENV !== "production" && !env.S3_ENDPOINT) {
  router.put("/uploads/local/*key", merchantGuard, express.raw({ type: "*/*", limit: "10mb" }), async (req, res) => {
    try {
      const tenantId = requireTenantId();
      const rawKey = Array.isArray(req.params.key)
        ? req.params.key.join("/")
        : typeof req.params.key === "string"
        ? req.params.key
        : "";
      const key = decodeURIComponent(rawKey);
      if (!key || key.includes("..") || path.isAbsolute(key)) {
        return res.status(400).json({ error: { code: "invalid_key", message: "Invalid file key" } });
      }
      // Force every write under the caller's own tenant prefix so stores cannot overwrite each other's media.
      // presignUpload keys already start with "<tenantId>/"; don't repeat it on disk (the /media URL has it once).
      const tenantDir = path.join(path.resolve(process.cwd(), "uploads"), tenantId);
      const rel = key.startsWith(`${tenantId}/`) ? key.slice(tenantId.length + 1) : key;
      const filePath = path.resolve(tenantDir, rel);
      if (filePath !== tenantDir && !filePath.startsWith(tenantDir + path.sep)) {
        return res.status(400).json({ error: { code: "invalid_key", message: "Invalid file key" } });
      }
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, req.body);
      res.status(200).send("OK");
    } catch (err: any) {
      res.status(500).json({ error: { code: "upload_failed", message: err.message || "Upload failed" } });
    }
  });
}

// ---------- Coupons ----------
type CouponRuleInput = { type?: string | null; value?: number | null; startsAt?: Date | null; endsAt?: Date | null };
function couponProblem(c: CouponRuleInput): { path: string; message: string } | null {
  if (c.type === "percent" && c.value != null && (c.value < 1 || c.value > 100)) return { path: "value", message: "A percent discount must be between 1 and 100" };
  if (c.type === "flat" && c.value != null && !Number.isInteger(c.value)) return { path: "value", message: "A flat discount must be a whole number of paise" };
  if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) return { path: "endsAt", message: "The end date must be after the start date" };
  return null;
}
export const couponIssues = (c: CouponRuleInput) => couponProblem(c)?.message ?? null;

const couponFields = z.object({
  code: z.string().trim().min(3).max(30),
  type: z.enum(["percent", "flat"]),
  value: z.number().positive(), // percent (1..100) or paise for flat
  minOrderPaise: z.number().int().min(0).default(0),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  startsAt: clearableDate.optional(),
  endsAt: clearableDate.optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().default(true),
});
export const couponBody = couponFields.superRefine((c, ctx) => {
  const p = couponProblem(c);
  if (p) ctx.addIssue({ code: "custom", path: [p.path], message: p.message });
});
add({ method: "get", path: "/coupons", summary: "List coupons", auth: "merchant", handler: () => Coupon.find().sort({ createdAt: -1 }).lean() });
add({ method: "post", path: "/coupons", summary: "Create coupon", auth: "merchant", body: couponBody, handler: ({ body }) => Coupon.create(body) });
add({
  method: "patch", path: "/coupons/:id", summary: "Update coupon", auth: "merchant", params: idParams, body: couponFields.partial(),
  handler: async ({ params, body, req }) => {
    const patch = sentKeys(body, req.body);
    const current = await Coupon.findById(params.id).lean();
    if (!current) throw notFound("Coupon");
    if (["type", "value", "startsAt", "endsAt"].some((k) => k in patch)) {
      const problem = couponIssues({ ...current, ...patch });
      if (problem) throw badRequest(problem);
    }
    return (await Coupon.findByIdAndUpdate(params.id, { $set: patch }, { new: true }).lean()) ?? Promise.reject(notFound("Coupon"));
  },
});
add({ method: "delete", path: "/coupons/:id", summary: "Delete coupon", auth: "merchant", params: idParams, handler: async ({ params }) => { await Coupon.deleteOne({ _id: params.id }); return { ok: true }; } });

// ---------- Static pages ----------
const pageBody = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().max(120).optional(),
  body: z.string().max(200_000).default(""),
  isPublished: z.boolean().default(true),
});
add({ method: "get", path: "/pages", summary: "List pages", auth: "merchant", handler: () => Page.find().sort({ title: 1 }).lean() });
add({ method: "post", path: "/pages", summary: "Create page", auth: "merchant", body: pageBody, handler: ({ body }) => Page.create({ ...body, slug: slugify(body.slug || "") || slugOrId(body.title) }) });
add({
  method: "patch", path: "/pages/:id", summary: "Update page", auth: "merchant", params: idParams, body: pageBody.partial(),
  handler: async ({ params, body, req }) => {
    const patch = sentKeys(body, req.body);
    // An empty (or symbols-only) slug keeps the current one.
    if ("slug" in patch) {
      const slug = slugify(patch.slug ?? "");
      if (slug) patch.slug = slug;
      else delete patch.slug;
    }
    return (await Page.findByIdAndUpdate(params.id, { $set: patch }, { new: true }).lean()) ?? Promise.reject(notFound("Page"));
  },
});
add({ method: "delete", path: "/pages/:id", summary: "Delete page", auth: "merchant", params: idParams, handler: async ({ params }) => { await Page.deleteOne({ _id: params.id }); return { ok: true }; } });
