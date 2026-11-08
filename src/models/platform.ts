import { Schema, model, type InferSchemaType } from "mongoose";

/** Global (non tenant-scoped) collections. */

const credentialsSchema = new Schema(
  {
    // Encrypted JSON blobs (AES-256-GCM). Never returned to clients.
    payment: { provider: { type: String, enum: ["cashfree", "razorpay", "mock", null], default: null }, secret: String, mode: { type: String, enum: ["sandbox", "production"], default: "sandbox" } },
    shipping: { provider: { type: String, enum: ["shiprocket", "delhivery", "mock", null], default: null }, secret: String },
    meta: { secret: String },
  },
  { _id: false },
);

const tenantSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: ["active", "suspended", "pending"], default: "active", index: true },
    blueprint: { type: String, default: null },
    isDemo: { type: Boolean, default: false },
    salesRepId: { type: Schema.Types.ObjectId, ref: "PlatformAdmin", default: null },
    handoverToken: { type: String, default: null, select: false },
    handoverExpiresAt: { type: Date, default: null },
    plan: { commissionRatePercent: { type: Number, default: 3 }, monthlyFeePaise: { type: Number, default: 0 } },
    business: {
      legalName: String,
      gstin: String,
      pan: String,
      stateCode: { type: String, default: "24" },
      address: String,
      email: String,
      phone: String,
      grievanceOfficer: { name: String, email: String, phone: String },
    },
    settings: {
      theme: { type: String, enum: ["general", "fashion", "grocery"], default: "general" },
      colors: { primary: { type: String, default: "#0E4D4A" }, accent: { type: String, default: "#F2A900" }, background: { type: String, default: "#FFFFFF" }, text: { type: String, default: "#1C2321" } },
      font: { type: String, default: "Figtree" },
      logoUrl: String,
      faviconUrl: String,
      banners: [{ imageUrl: String, title: String, subtitle: String, link: String }],
      homeSections: { type: [String], default: ["hero", "categories", "featured", "new", "about"] },
      whatsappNumber: String,
      social: { instagram: String, facebook: String, youtube: String },
      seo: { title: String, description: String },
      checkout: { codEnabled: { type: Boolean, default: true }, codMaxPaise: { type: Number, default: 500000 }, prepaidDiscountPaise: { type: Number, default: 0 }, freeShippingAbovePaise: { type: Number, default: 99900 }, flatShippingPaise: { type: Number, default: 4900 }, codFeePaise: { type: Number, default: 0 } },
      shippingOrigin: { pickupLocation: String, pincode: String, defaultWeightKg: { type: Number, default: 0.5 }, dims: { l: { type: Number, default: 20 }, b: { type: Number, default: 15 }, h: { type: Number, default: 5 } } },
      tracking: { metaPixelId: String, ga4Id: String, googleAdsId: String },
    },
    credentials: { type: credentialsSchema, default: () => ({}), select: false },
    billing: {
      mandateStatus: { type: String, enum: ["none", "pending", "active", "failed"], default: "none" },
      mandateRef: String,
      graceDays: { type: Number, default: 10 },
    },
    authVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Tenant = model("Tenant", tenantSchema);
export type TenantDoc = InferSchemaType<typeof tenantSchema> & { _id: any };

const domainSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    hostname: { type: String, required: true, unique: true, lowercase: true, trim: true },
    kind: { type: String, enum: ["subdomain", "custom"], required: true },
    status: { type: String, enum: ["pending", "verified", "active", "error"], default: "pending" },
    verificationToken: String,
    isPrimary: { type: Boolean, default: false },
    lastCheckedAt: Date,
    lastError: String,
  },
  { timestamps: true },
);
export const Domain = model("Domain", domainSchema);

const platformAdminSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    name: String,
    passwordHash: { type: String, required: true, select: false },
    twoFactorSecret: { type: String, select: false },
    authVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const PlatformAdmin = model("PlatformAdmin", platformAdminSchema);

const auditSchema = new Schema(
  {
    actor: String,
    action: { type: String, required: true },
    tenantId: Schema.Types.ObjectId,
    meta: Schema.Types.Mixed,
  },
  { timestamps: true },
);
export const AuditLog = model("AuditLog", auditSchema);

/** Idempotency for webhooks: the same event is processed once. */
const webhookEventSchema = new Schema(
  { provider: String, eventKey: { type: String, unique: true }, tenantId: Schema.Types.ObjectId, payload: Schema.Types.Mixed },
  { timestamps: true },
);
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
export const WebhookEvent = model("WebhookEvent", webhookEventSchema);

/** Platform-wide counters (e.g. commission invoice numbers per financial year). */
const platformCounterSchema = new Schema({ key: { type: String, unique: true }, seq: { type: Number, default: 0 } });
export const PlatformCounter = model("PlatformCounter", platformCounterSchema);
