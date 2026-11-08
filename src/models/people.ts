import { Schema, model } from "mongoose";
import { tenantPlugin, tenantIdField } from "../db/tenantPlugin.js";

const userSchema = new Schema(
  {
    tenantId: tenantIdField,
    email: { type: String, required: true, lowercase: true, trim: true },
    name: String,
    phone: String,
    role: { type: String, enum: ["owner", "staff"], default: "staff" },
    passwordHash: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true },
    authVersion: { type: Number, default: 0 },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
userSchema.plugin(tenantPlugin);
// Email is unique across the platform so merchants can sign in without choosing a store first.
userSchema.index({ email: 1 }, { unique: true });
export const User = model("User", userSchema);

const addressSchema = new Schema({
  name: String,
  phone: String,
  line1: String,
  line2: String,
  city: String,
  state: String,
  stateCode: String,
  pincode: String,
  country: { type: String, default: "India" },
});

const customerSchema = new Schema(
  {
    tenantId: tenantIdField,
    phone: { type: String, required: true },
    name: String,
    email: String,
    addresses: [addressSchema],
    marketingOptIn: { type: Boolean, default: false },
    lastOrderAt: Date,
    orderCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
customerSchema.plugin(tenantPlugin);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
export const Customer = model("Customer", customerSchema);

const otpSchema = new Schema({
    tenantId: tenantIdField,
  phone: { type: String, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
otpSchema.plugin(tenantPlugin);
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ tenantId: 1, phone: 1 });
export const OtpCode = model("OtpCode", otpSchema);

const cartSchema = new Schema(
  {
    tenantId: tenantIdField,
    token: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, default: null },
    items: [{ productId: Schema.Types.ObjectId, variantId: Schema.Types.ObjectId, quantity: { type: Number, min: 1 } }],
  },
  { timestamps: true },
);
cartSchema.plugin(tenantPlugin);
cartSchema.index({ tenantId: 1, token: 1 }, { unique: true });
cartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
export const Cart = model("Cart", cartSchema);
export { addressSchema };
