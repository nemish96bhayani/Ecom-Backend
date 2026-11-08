import { describe, it, expect } from "vitest";
import { splitInclusive, splitGst, couponDiscount } from "../../src/services/pricing.js";
import { commissionAmount, commissionBase } from "../../src/services/commission.js";

describe("GST helpers", () => {
  it("splits a GST-inclusive price into taxable value and tax", () => {
    const r = splitInclusive(105000, 5); // ₹1,050 incl. 5%
    expect(r.taxablePaise).toBe(100000);
    expect(r.taxPaise).toBe(5000);
  });
  it("uses CGST+SGST inside the same state and IGST across states", () => {
    expect(splitGst(5001, "24", "24")).toEqual({ cgstPaise: 2500, sgstPaise: 2501, igstPaise: 0 });
    expect(splitGst(5000, "24", "27")).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 5000 });
  });
});

describe("coupons", () => {
  it("caps percent discounts", () => {
    expect(couponDiscount({ type: "percent", value: 20, maxDiscountPaise: 10000 }, 100000)).toBe(10000);
  });
  it("respects the minimum order value", () => {
    expect(couponDiscount({ type: "flat", value: 5000, minOrderPaise: 50000 }, 40000)).toBe(0);
  });
  it("never discounts more than the subtotal", () => {
    expect(couponDiscount({ type: "flat", value: 99999 }, 1000)).toBe(1000);
  });
});

describe("commission", () => {
  it("is 3% of merchandise value after discount", () => {
    const base = commissionBase({ subtotalPaise: 100000, discountPaise: 10000 });
    expect(base).toBe(90000);
    expect(commissionAmount(base, 3)).toBe(2700);
  });
});
