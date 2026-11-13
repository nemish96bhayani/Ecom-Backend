import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/** `ver` (the user's authVersion) lets merchantGuard reject access tokens of revoked sessions; older tokens may lack it. */
export type MerchantClaims = { sub: string; tenantId: string; role: "owner" | "staff"; kind: "merchant"; ver?: number };
export type PlatformClaims = { sub: string; kind: "platform" };
export type CustomerClaims = { sub: string; tenantId: string; kind: "customer" };
export type AccessClaims = MerchantClaims | PlatformClaims;

// Pin the algorithm on every verify so a token can never choose how it is checked.
const VERIFY = { algorithms: ["HS256" as const] };

export const signAccess = (c: AccessClaims) => jwt.sign(c, env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
export const signRefresh = (c: AccessClaims & { ver: number }) =>
  jwt.sign(c, env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
export const verifyAccess = (t: string) => jwt.verify(t, env.JWT_ACCESS_SECRET, VERIFY) as AccessClaims;
export const verifyRefresh = (t: string) => jwt.verify(t, env.JWT_REFRESH_SECRET, VERIFY) as AccessClaims & { ver: number };
export const signCustomer = (c: CustomerClaims) => jwt.sign(c, env.JWT_CUSTOMER_SECRET, { expiresIn: "30d" });
export const verifyCustomer = (t: string) => jwt.verify(t, env.JWT_CUSTOMER_SECRET, VERIFY) as CustomerClaims;
