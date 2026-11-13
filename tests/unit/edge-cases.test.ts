import { describe, it, expect } from "vitest";
import { z } from "zod";
import { sentKeys, slugify, slugOrId, queryBool, queryDateFrom, queryDateTo } from "../../src/modules/_shared.js";
import { couponBody, couponIssues } from "../../src/modules/adminCatalog.js";
import { previousPeriod, currentPeriod, closedPeriodError } from "../../src/services/statements.js";
import { isReservedSlug, tenantSlug } from "../../src/modules/platform.js";

describe("C1: PATCH bodies keep only the keys the client sent", () => {
  const schema = z.object({ minOrderPaise: z.number().default(0), isActive: z.boolean().default(true), code: z.string().optional() });

  it("Zod 4 .partial() still fills .default() values (the bug)", () => {
    expect(schema.partial().parse({ isActive: false })).toEqual({ minOrderPaise: 0, isActive: false });
  });

  it("sentKeys strips the defaults that were not in the request", () => {
    const raw = { isActive: false };
    expect(sentKeys(schema.partial().parse(raw), raw)).toEqual({ isActive: false });
  });

  it("keeps explicit nulls and falsy values the client did send", () => {
    const s = z.object({ a: z.number().nullable().default(5), b: z.string().default("x") }).partial();
    const raw = { a: null, b: "" };
    expect(sentKeys(s.parse(raw), raw)).toEqual({ a: null, b: "" });
  });

  it("returns an empty object when the raw body is not an object", () => {
    expect(sentKeys({ a: 1 }, undefined)).toEqual({});
  });
});

describe("C4/C14/C24: coupon validation", () => {
  const base = { code: "DIWALI10", type: "percent" as const, value: 10 };

  it("endsAt null and empty string both mean 'no end date' (not 1970)", () => {
    expect(couponBody.parse({ ...base, endsAt: null }).endsAt).toBeNull();
    expect(couponBody.parse({ ...base, endsAt: "" }).endsAt).toBeNull();
    expect(couponBody.parse({ ...base, startsAt: "" }).startsAt).toBeNull();
  });

  it("still parses a real date", () => {
    const d = couponBody.parse({ ...base, endsAt: "2026-12-31T23:59:59.999+05:30" }).endsAt as Date;
    expect(d.toISOString()).toBe("2026-12-31T18:29:59.999Z");
  });

  it("rejects endsAt before startsAt", () => {
    expect(couponBody.safeParse({ ...base, startsAt: "2026-12-10", endsAt: "2026-12-01" }).success).toBe(false);
  });

  it("percent must be 1..100", () => {
    expect(couponBody.safeParse({ ...base, value: 150 }).success).toBe(false);
    expect(couponBody.safeParse({ ...base, value: 0.5 }).success).toBe(false);
    expect(couponBody.safeParse({ ...base, value: 100 }).success).toBe(true);
  });

  it("flat must be whole paise", () => {
    expect(couponBody.safeParse({ ...base, type: "flat", value: 150.5 }).success).toBe(false);
    expect(couponBody.safeParse({ ...base, type: "flat", value: 15000 }).success).toBe(true);
  });

  it("trims the code before checking its length", () => {
    expect(couponBody.safeParse({ ...base, code: "  AB  " }).success).toBe(false);
    expect(couponBody.parse({ ...base, code: "  ABC  " }).code).toBe("ABC");
  });

  it("couponIssues checks a merged PATCH against the stored type", () => {
    expect(couponIssues({ type: "percent", value: 120 })).toMatch(/100/);
    expect(couponIssues({ type: "flat", value: 120 })).toBeNull();
    expect(couponIssues({ type: "percent", value: 10, startsAt: new Date("2026-12-10"), endsAt: new Date("2026-12-01") })).toMatch(/after/);
  });
});

describe("C5: Unicode-aware slugify", () => {
  it("keeps existing ASCII and Latin outputs unchanged", () => {
    expect(slugify("Silk Kurta!")).toBe("silk-kurta");
    expect(slugify("  Men's  T_Shirt -- XL ")).toBe("mens-t-shirt-xl");
    expect(slugify("Café Crème")).toBe("cafe-creme");
    expect(slugify("Straße")).toBe("strae");
    expect(slugify("a".repeat(100))).toHaveLength(80);
  });

  it("produces a slug for Hindi and other non-Latin titles", () => {
    expect(slugify("सूती कुर्ता")).toBe("सूती-कुर्ता");
    expect(slugify("ಹತ್ತಿ ಸೀರೆ")).toBe("ಹತ್ತಿ-ಸೀರೆ");
  });

  it("keeps Devanagari vowel signs (matras) and nukta", () => {
    const s = slugify("Silk साड़ी");
    expect(s).toBe("silk-" + "साड़ी".normalize("NFKD").normalize("NFC"));
    expect(s).toMatch(/ा/); // ा (aa matra)
    expect(s).toMatch(/ी/); // ी (ii matra)
    expect(slugify("नई साड़ी")).toBe("नई-" + "साड़ी".normalize("NFKD").normalize("NFC"));
  });

  it("slugOrId falls back to a short id when nothing usable remains", () => {
    expect(slugify("🎉🎉")).toBe("");
    expect(slugOrId("🎉🎉")).toMatch(/^item-[a-z0-9]{6}$/);
    expect(slugOrId("Silk Kurta!")).toBe("silk-kurta");
  });
});

describe("C7: boolean query params", () => {
  const q = z.object({ lowStock: queryBool.optional() });
  it("'false' and '0' mean false, 'true' and '1' mean true", () => {
    expect(q.parse({ lowStock: "false" }).lowStock).toBe(false);
    expect(q.parse({ lowStock: "0" }).lowStock).toBe(false);
    expect(q.parse({ lowStock: "true" }).lowStock).toBe(true);
    expect(q.parse({ lowStock: "1" }).lowStock).toBe(true);
    expect(q.parse({}).lowStock).toBeUndefined();
  });
  it("rejects garbage instead of treating it as true", () => {
    expect(q.safeParse({ lowStock: "maybe" }).success).toBe(false);
  });
});

describe("C21: date-only filters use IST day boundaries", () => {
  it("a date-only `to` covers the whole IST day", () => {
    expect(queryDateTo.parse("2026-11-12").toISOString()).toBe("2026-11-12T18:29:59.999Z");
  });
  it("a date-only `from` starts at IST midnight", () => {
    expect(queryDateFrom.parse("2026-11-12").toISOString()).toBe("2026-11-11T18:30:00.000Z");
  });
  it("full timestamps pass through unchanged", () => {
    expect(queryDateTo.parse("2026-11-12T10:00:00.000Z").toISOString()).toBe("2026-11-12T10:00:00.000Z");
  });
});

describe("A1: previousPeriod uses the IST month", () => {
  it("at 02:00 IST on 1 Nov (still 31 Oct in UTC) bills October", () => {
    expect(previousPeriod(new Date("2026-11-01T02:00:00+05:30"))).toBe("2026-10");
  });
  it("at 00:30 IST on the 1st", () => {
    expect(previousPeriod(new Date("2026-11-01T00:30:00+05:30"))).toBe("2026-10");
  });
  it("across a year boundary", () => {
    expect(previousPeriod(new Date("2027-01-01T02:00:00+05:30"))).toBe("2026-12");
  });
  it("late on the last day in IST is still the previous month", () => {
    expect(previousPeriod(new Date("2026-10-31T23:30:00+05:30"))).toBe("2026-09");
  });
  it("currentPeriod is IST too", () => {
    expect(currentPeriod(new Date("2026-11-01T00:30:00+05:30"))).toBe("2026-11");
  });
});

describe("A2: statements only for months that have ended", () => {
  const now = new Date("2026-11-13T12:00:00+05:30");
  it("accepts a past month", () => {
    expect(closedPeriodError("2026-10", now)).toBeNull();
  });
  it("rejects the current and future months", () => {
    expect(closedPeriodError("2026-11", now)).toMatch(/hasn't ended/);
    expect(closedPeriodError("2027-01", now)).toMatch(/hasn't ended/);
  });
  it("rejects month 00 and 13+", () => {
    expect(closedPeriodError("2026-00", now)).toMatch(/month/i);
    expect(closedPeriodError("2026-13", now)).toMatch(/month/i);
  });
  it("on 1 Nov 00:30 IST, October has ended", () => {
    expect(closedPeriodError("2026-10", new Date("2026-11-01T00:30:00+05:30"))).toBeNull();
  });
});

describe("A11: tenant subdomain rules", () => {
  it("reserves platform hostnames", () => {
    for (const s of ["www", "admin", "api", "platform", "localhost", "static", "cdn", "assets", "status", "help", "support", "billing"])
      expect(isReservedSlug(s)).toBe(true);
    expect(isReservedSlug("sorath")).toBe(false);
  });
  it("is hostname-safe", () => {
    expect(tenantSlug.safeParse("my-store").success).toBe(true);
    expect(tenantSlug.safeParse("-store").success).toBe(false);
    expect(tenantSlug.safeParse("store-").success).toBe(false);
    expect(tenantSlug.safeParse("a".repeat(64)).success).toBe(false);
    expect(tenantSlug.safeParse("My_Store").success).toBe(false);
  });
});

describe("C16: invalid ObjectId in a query is a 400", () => {
  it("maps mongoose CastError to 400", async () => {
    const mongoose = (await import("mongoose")).default;
    const { errorHandler } = await import("../../src/middleware/errors.js");
    const err = new mongoose.Error.CastError("ObjectId", "abc", "customerId");
    let status = 0;
    let body: any;
    const res: any = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) };
    errorHandler(err, { path: "/x" } as any, res, () => undefined);
    expect(status).toBe(400);
    expect(body.error.message).toContain("customerId");
  });
});
