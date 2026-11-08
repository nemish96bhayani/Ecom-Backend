import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export type MerchantClaims = { sub: string; tenantId: string; role: "owner" | "staff"; kind: "merchant" };
export type PlatformClaims = { sub: string; kind: "platform" };
export type CustomerClaims = { sub: string; tenantId: string; kind: "customer" };
export type AccessClaims = MerchantClaims | PlatformClaims;

export const signAccess = (c: AccessClaims) => jwt.sign(c, env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
export const signRefresh = (c: AccessClaims & { ver: number }) =>
  jwt.sign(c, env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
export const verifyAccess = (t: string) => jwt.verify(t, env.JWT_ACCESS_SECRET) as AccessClaims;
export const verifyRefresh = (t: string) => jwt.verify(t, env.JWT_REFRESH_SECRET) as AccessClaims & { ver: number };
export const signCustomer = (c: CustomerClaims) => jwt.sign(c, env.JWT_CUSTOMER_SECRET, { expiresIn: "30d" });
export const verifyCustomer = (t: string) => jwt.verify(t, env.JWT_CUSTOMER_SECRET) as CustomerClaims;
