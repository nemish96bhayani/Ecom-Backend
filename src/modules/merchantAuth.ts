import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Response } from "express";
import { moduleFor } from "./_shared.js";
import { User } from "../models/people.js";
import { PlatformAdmin, Tenant, AuditLog } from "../models/platform.js";
import { runWithoutTenant, requireTenantId } from "../db/tenantContext.js";
import { signAccess, signRefresh, verifyRefresh } from "../lib/jwt.js";
import { unauthorized, badRequest, notFound } from "../lib/errors.js";
import { isProd } from "../config/env.js";
import { idParams } from "../http/route.js";

const { router, add } = moduleFor("Auth", "/api/v1/auth");
export default router;

const REFRESH_COOKIE = "rt";
const setRefresh = (res: Response, token: string) =>
  res.cookie(REFRESH_COOKIE, token, { httpOnly: true, secure: isProd, sameSite: "strict", path: "/api/v1/auth", maxAge: 30 * 86_400_000 });

const login = z.object({ email: z.email(), password: z.string().min(1) });

add({
  method: "post", path: "/login", summary: "Merchant sign in", auth: "public", body: login,
  handler: async ({ body, res }) => {
    const user = await runWithoutTenant("merchant-login", () => User.findOne({ email: body.email.toLowerCase(), isActive: true }).select("+passwordHash").lean());
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw unauthorized("Email or password is incorrect");
    const tenant = await Tenant.findById(user.tenantId).select("status name slug").lean();
    if (!tenant || tenant.status === "suspended") throw unauthorized("This store is suspended. Contact platform support.");
    const claims = { sub: String(user._id), tenantId: String(user.tenantId), role: user.role as "owner" | "staff", kind: "merchant" as const };
    setRefresh(res, signRefresh({ ...claims, ver: user.authVersion ?? 0 }));
    await runWithoutTenant("merchant-login", () => User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }));
    return { accessToken: signAccess(claims), user: { id: user._id, email: user.email, name: user.name, role: user.role }, tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug } };
  },
});

add({
  method: "post", path: "/platform/login", summary: "Super-admin sign in", auth: "public", body: login,
  handler: async ({ body, res }) => {
    const admin = await PlatformAdmin.findOne({ email: body.email.toLowerCase() }).select("+passwordHash").lean();
    if (!admin || !(await bcrypt.compare(body.password, admin.passwordHash))) throw unauthorized("Email or password is incorrect");
    const claims = { sub: String(admin._id), kind: "platform" as const };
    setRefresh(res, signRefresh({ ...claims, ver: admin.authVersion ?? 0 }));
    await AuditLog.create({ actor: `platform:${admin._id}`, action: "platform.login" });
    return { accessToken: signAccess(claims), user: { id: admin._id, email: admin.email, name: admin.name, role: "platform" } };
  },
});

add({
  method: "post", path: "/refresh", summary: "Exchange refresh cookie for a new access token", auth: "public",
  handler: async ({ req, res }) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized();
    let c;
    try {
      c = verifyRefresh(token);
    } catch {
      throw unauthorized("Your session expired. Sign in again.");
    }
    if (c.kind === "merchant") {
      const u = await runWithoutTenant("refresh", () => User.findById(c.sub).lean());
      if (!u || !u.isActive || (u.authVersion ?? 0) !== c.ver) throw unauthorized("Your session expired. Sign in again.");
      const claims = { sub: c.sub, tenantId: c.tenantId, role: u.role as "owner" | "staff", kind: "merchant" as const };
      setRefresh(res, signRefresh({ ...claims, ver: c.ver }));
      return { accessToken: signAccess(claims) };
    }
    const a = await PlatformAdmin.findById(c.sub).lean();
    if (!a || (a.authVersion ?? 0) !== c.ver) throw unauthorized("Your session expired. Sign in again.");
    setRefresh(res, signRefresh({ sub: c.sub, kind: "platform", ver: c.ver }));
    return { accessToken: signAccess({ sub: c.sub, kind: "platform" }) };
  },
});

add({
  method: "post", path: "/logout", summary: "Sign out", auth: "public",
  handler: ({ res }) => {
    res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  },
});

add({
  method: "get", path: "/me", summary: "Current merchant user and store", auth: "merchant",
  handler: async ({ req }) => {
    const user = await User.findById(req.auth!.sub).lean();
    const tenant = await Tenant.findById(requireTenantId()).lean();
    if (!user || !tenant) throw notFound("User");
    return { user: { id: user._id, email: user.email, name: user.name, role: user.role }, tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug, status: tenant.status } };
  },
});

add({
  method: "post", path: "/change-password", summary: "Change your password (signs out other sessions)", auth: "merchant",
  body: z.object({ currentPassword: z.string(), newPassword: z.string().min(10, "Use at least 10 characters") }),
  handler: async ({ req, body }) => {
    const user = await User.findById(req.auth!.sub).select("+passwordHash");
    if (!user || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) throw badRequest("Current password is incorrect");
    user.passwordHash = await bcrypt.hash(body.newPassword, 12);
    user.authVersion = (user.authVersion ?? 0) + 1;
    await user.save();
    return { ok: true };
  },
});

// ---- Staff management (owner only) ----
add({
  method: "get", path: "/staff", summary: "List store staff", auth: "owner",
  handler: () => User.find().select("email name role isActive lastLoginAt").lean(),
});

add({
  method: "post", path: "/staff", summary: "Add a staff member", auth: "owner",
  body: z.object({ email: z.email(), name: z.string().min(1), password: z.string().min(10), role: z.enum(["owner", "staff"]).default("staff") }),
  handler: async ({ body }) => {
    const u = await User.create({ email: body.email, name: body.name, role: body.role, passwordHash: await bcrypt.hash(body.password, 12) });
    return { id: u._id, email: u.email, name: u.name, role: u.role };
  },
});

add({
  method: "patch", path: "/staff/:id", summary: "Update or deactivate a staff member", auth: "owner", params: idParams,
  body: z.object({ role: z.enum(["owner", "staff"]).optional(), isActive: z.boolean().optional() }),
  handler: async ({ params, body, req }) => {
    if (params.id === req.auth!.sub && body.isActive === false) throw badRequest("You can't deactivate yourself");
    const u = await User.findByIdAndUpdate(params.id, { $set: body, $inc: { authVersion: 1 } }, { new: true }).lean();
    if (!u) throw notFound("Staff member");
    return { id: u._id, role: u.role, isActive: u.isActive };
  },
});

// ---- Handover token verification and claim ----
add({
  method: "get", path: "/handover/:token", summary: "Verify client handover token", auth: "public",
  params: z.object({ token: z.string().min(10) }),
  handler: async ({ params }) => {
    const tenant = await Tenant.findOne({
      handoverToken: params.token,
      handoverExpiresAt: { $gt: new Date() },
    }).select("name slug blueprint isDemo handoverExpiresAt").lean();
    if (!tenant) throw badRequest("This store invite link is invalid or has expired.");
    return { valid: true, tenantName: tenant.name, slug: tenant.slug, blueprint: tenant.blueprint, expiresAt: (tenant as any).handoverExpiresAt };
  },
});

add({
  method: "post", path: "/handover/:token/claim", summary: "Claim store ownership via handover invite", auth: "public",
  params: z.object({ token: z.string().min(10) }),
  body: z.object({ name: z.string().min(1), email: z.email(), password: z.string().min(10) }),
  handler: async ({ params, body, res }) => {
    const tenant = await Tenant.findOne({
      handoverToken: params.token,
      handoverExpiresAt: { $gt: new Date() },
    }).select("+handoverToken +handoverExpiresAt");
    if (!tenant) throw badRequest("This store invite link is invalid or has expired.");

    // Check if user already exists
    let user = await runWithoutTenant("claim-user", () => User.findOne({ email: body.email.toLowerCase() }));
    const passwordHash = await bcrypt.hash(body.password, 12);

    if (user) {
      if (String(user.tenantId) !== String(tenant._id)) {
        throw badRequest("This email is already registered with another store. Please use a different email.");
      }
      user.name = body.name;
      user.passwordHash = passwordHash;
      user.role = "owner";
      user.isActive = true;
      user.authVersion = (user.authVersion ?? 0) + 1;
      await user.save();
    } else {
      user = await runWithoutTenant("claim-user", () =>
        User.create({
          tenantId: tenant._id,
          name: body.name,
          email: body.email.toLowerCase(),
          passwordHash,
          role: "owner",
          isActive: true,
        })
      );
    }

    // Convert store from demo to live client store
    tenant.isDemo = false;
    (tenant as any).handoverToken = null;
    (tenant as any).handoverExpiresAt = null;
    await tenant.save();

    const claims = { sub: String(user._id), tenantId: String(tenant._id), role: "owner" as const, kind: "merchant" as const };
    setRefresh(res, signRefresh({ ...claims, ver: user.authVersion ?? 0 }));
    await AuditLog.create({ actor: `user:${user._id}`, action: "tenant.handover_claimed", tenantId: tenant._id, meta: { email: user.email } });

    return {
      accessToken: signAccess(claims),
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
      tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug },
    };
  },
});

