import { Schema, model } from "mongoose";
import { tenantPlugin, tenantIdField } from "../db/tenantPlugin.js";

const categorySchema = new Schema(
  {
    tenantId: tenantIdField,
    name: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    imageUrl: String,
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
categorySchema.plugin(tenantPlugin);
categorySchema.index({ tenantId: 1, slug: 1 }, { unique: true });
export const Category = model("Category", categorySchema);

const variantSchema = new Schema({
  sku: { type: String, required: true },
  options: { type: Map, of: String, default: {} }, // e.g. { Size: "M", Colour: "Blue" }
  pricePaise: { type: Number, required: true, min: 0 }, // GST inclusive selling price
  compareAtPaise: { type: Number, default: null },
  stock: { type: Number, default: 0, min: 0 },
  weightKg: { type: Number, default: null },
  imageUrl: String,
});

const productSchema = new Schema(
  {
    tenantId: tenantIdField,
    title: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true },
    description: { type: String, default: "" },
    brand: String,
    categoryIds: [{ type: Schema.Types.ObjectId, index: true }],
    images: [{ url: String, alt: String }],
    optionNames: [String],
    variants: { type: [variantSchema], validate: (v: unknown[]) => v.length > 0 },
    hsn: String,
    gstRatePercent: { type: Number, default: 5 },
    status: { type: String, enum: ["draft", "active", "archived"], default: "active" },
    isFeatured: { type: Boolean, default: false },
    tags: [String],
    seo: { title: String, description: String },
  },
  { timestamps: true },
);
productSchema.plugin(tenantPlugin);
productSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
productSchema.index({ tenantId: 1, "variants.sku": 1 });
productSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
productSchema.index({ title: "text", description: "text", tags: "text" });
export const Product = model("Product", productSchema);

const pageSchema = new Schema(
  {
    tenantId: tenantIdField, title: String, slug: { type: String, lowercase: true }, body: String, isPublished: { type: Boolean, default: true } },
  { timestamps: true },
);
pageSchema.plugin(tenantPlugin);
pageSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
export const Page = model("Page", pageSchema);

const couponSchema = new Schema(
  {
    tenantId: tenantIdField,
    code: { type: String, required: true, uppercase: true, trim: true },
    type: { type: String, enum: ["percent", "flat"], required: true },
    value: { type: Number, required: true }, // percent or paise
    minOrderPaise: { type: Number, default: 0 },
    maxDiscountPaise: { type: Number, default: null },
    startsAt: Date,
    endsAt: Date,
    usageLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
couponSchema.plugin(tenantPlugin);
couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Coupon = model("Coupon", couponSchema);
