import { describe, it, expect } from "vitest";
import { normalizeHost } from "../../src/services/tenantLookup.js";
import { env } from "../../src/config/env.js";

describe("Domain Normalization and Host Resolution", () => {
  it("normalizes hosts by stripping ports, trailing dots, and converting to lowercase", () => {
    expect(normalizeHost("Aura.Localhost:3000")).toBe("aura.localhost");
    expect(normalizeHost("SHOP.ClientBrand.IN.:443")).toBe("shop.clientbrand.in");
    expect(normalizeHost("  store.yourplatform.in:80  ")).toBe("store.yourplatform.in");
  });

  it("recognizes platform subdomains and localhost variations for Caddy TLS approval", () => {
    const isApprovedHost = (rawHost: string) => {
      const domain = normalizeHost(rawHost);
      if (!domain) return false;
      if (domain === "localhost" || domain.endsWith(".localhost")) return true;
      if (domain === env.PLATFORM_DOMAIN || domain.endsWith(`.${env.PLATFORM_DOMAIN}`)) return true;
      return false;
    };

    expect(isApprovedHost("aura.localhost:3000")).toBe(true);
    expect(isApprovedHost(`shop.${env.PLATFORM_DOMAIN}:443`)).toBe(true);
    expect(isApprovedHost(`${env.PLATFORM_DOMAIN}`)).toBe(true);
    expect(isApprovedHost("random-unverified-domain.com")).toBe(false);
    expect(isApprovedHost("")).toBe(false);
  });
});
