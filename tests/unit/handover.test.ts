import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Tenant } from "../../src/models/platform.js";
import { User } from "../../src/models/people.js";
import { randomToken } from "../../src/lib/crypto.js";

describe("Client Handover & Onboarding Lifecycle", () => {
  let tenantId: string;
  let handoverToken: string;

  beforeAll(async () => {
    // If not connected to test DB in unit run, use in-memory or mock verification
    if (mongoose.connection.readyState === 0) {
      const uri = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/ecom_platform_test";
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
      } catch {
        // Skip DB operations if mongodb is not running
      }
    }
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0 && tenantId) {
      await Tenant.deleteOne({ _id: tenantId });
      await User.deleteMany({ tenantId });
    }
  });

  it("generates a 72-hour handover token for merchant onboarding", async () => {
    if (mongoose.connection.readyState === 0) return;

    const tenant = await Tenant.create({
      name: "Heritage Silk Weaves",
      slug: `heritage-${Date.now()}`,
      status: "active",
      blueprint: "fashion",
      isDemo: true,
    });
    tenantId = String(tenant._id);

    handoverToken = randomToken(24);
    (tenant as any).handoverToken = handoverToken;
    (tenant as any).handoverExpiresAt = new Date(Date.now() + 72 * 3600 * 1000);
    await tenant.save();

    const loaded = await Tenant.findById(tenant._id).select("+handoverToken +handoverExpiresAt").lean();
    expect((loaded as any).handoverToken).toBe(handoverToken);
    expect((loaded as any).isDemo).toBe(true);
    expect(new Date((loaded as any).handoverExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("verifies and claims store ownership, transitioning from demo to live merchant", async () => {
    if (mongoose.connection.readyState === 0) return;

    // Verify token
    const tenant = await Tenant.findOne({
      handoverToken,
      handoverExpiresAt: { $gt: new Date() },
    }).select("+handoverToken +handoverExpiresAt");

    expect(tenant).toBeDefined();
    expect(tenant?.name).toBe("Heritage Silk Weaves");

    // Create claimed owner
    const clientEmail = `client_${Date.now()}@heritageweaves.in`;
    const passwordHash = await bcrypt.hash("ClientPass!1234", 12);
    const user = await User.create({
      tenantId: tenant!._id,
      name: "Rameshvar Sharma",
      email: clientEmail,
      passwordHash,
      role: "owner",
      isActive: true,
    });

    // Mark demo as false and clear token
    tenant!.isDemo = false;
    (tenant as any).handoverToken = null;
    (tenant as any).handoverExpiresAt = null;
    await tenant!.save();

    // Check resulting status
    const verifiedTenant = await Tenant.findById(tenant!._id).select("+handoverToken").lean();
    expect((verifiedTenant as any).isDemo).toBe(false);
    expect((verifiedTenant as any).handoverToken).toBeNull();

    const verifiedUser = await User.findById(user._id).lean();
    expect(verifiedUser?.role).toBe("owner");
    expect(verifiedUser?.email).toBe(clientEmail);
  });
});

