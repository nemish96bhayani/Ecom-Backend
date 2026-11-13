import { describe, it, expect } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import { slugify } from "../../src/modules/_shared.js";
import { toPaise } from "../../src/lib/money.js";

describe("Catalog Bulk CSV Import Parsing & Hardening", () => {
  it("handles UTF-8 BOM from Microsoft Excel exports", () => {
    // Excel adds \uFEFF to the beginning of the file
    const excelCsvWithBom = "\uFEFFtitle,category,sku,price,stock\nOrganic Basmati Rice,Gourmet,RICE-1KG,₹149.00,100";
    const rows: Record<string, string>[] = parseCsv(excelCsvWithBom, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("Organic Basmati Rice");
    expect(rows[0]!.category).toBe("Gourmet");
  });

  it("sanitizes rupee symbols and formatted currency strings", () => {
    const rawPrice1 = "₹ 1,499.00";
    const rawPrice2 = "INR 799";
    const rawPrice3 = "2,50,000";

    const cleanNumber = (val: string | undefined): number => {
      if (!val) return NaN;
      const cleaned = val.replace(/[^\d.]/g, "");
      return cleaned ? Number(cleaned) : NaN;
    };

    expect(cleanNumber(rawPrice1)).toBe(1499);
    expect(toPaise(cleanNumber(rawPrice1))).toBe(149900);

    expect(cleanNumber(rawPrice2)).toBe(799);
    expect(toPaise(cleanNumber(rawPrice2))).toBe(79900);

    expect(cleanNumber(rawPrice3)).toBe(250000);
  });

  it("supports multi-variant grouping with multiple options (Size, Color, Material)", () => {
    const csvData = `title,category,sku,option1_name,option1_value,option2_name,option2_value,price,compare_at_price,stock
Silk Saree,Apparel,SAR-RED-M,Color,Red,Size,M,"₹2,499","₹3,999",10
Silk Saree,Apparel,SAR-BLU-L,Color,Blue,Size,L,"₹2,699","₹4,199",5`;

    const rows: Record<string, string>[] = parseCsv(csvData, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_quotes: true,
    });

    const groups = new Map<string, Record<string, string>[]>();
    for (const r of rows) {
      const key = slugify(r.slug || r.title || "");
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }

    expect(groups.size).toBe(1);
    const variants = groups.get("silk-saree")!;
    expect(variants.length).toBe(2);
    expect(variants[0]!.option1_value).toBe("Red");
    expect(variants[1]!.option1_value).toBe("Blue");
  });

  it("extracts and deduplicates multi-image URLs separated by delimiters", () => {
    const rawImages = "https://cdn.example.com/img1.jpg, https://cdn.example.com/img2.jpg; https://cdn.example.com/img1.jpg";
    const parsed = Array.from(
      new Set(
        rawImages
          .split(/[\s,;|]+/)
          .map((u) => u.trim())
          .filter((u) => /^https?:\/\//i.test(u))
      )
    );

    expect(parsed.length).toBe(2);
    expect(parsed[0]).toBe("https://cdn.example.com/img1.jpg");
    expect(parsed[1]).toBe("https://cdn.example.com/img2.jpg");
  });
});

import { Types } from "mongoose";
import { parseImportCsv, groupImportRows, planImportProduct, parseMoneyPaise, parseCount } from "../../src/services/csvImport.js";
import { AppError } from "../../src/lib/errors.js";

describe("C17: CSV parsing problems give clean 400s", () => {
  it("a malformed CSV is a 400, not a 500", () => {
    let err: unknown;
    try {
      parseImportCsv('title,price\n"Unclosed quote,100');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
  });

  it("matches headers case-insensitively and trims them", () => {
    const { rows, columns } = parseImportCsv("Title , SKU,Price,Option1 Name\nSilk Kurta,K-1,999,Size");
    expect(columns.has("title")).toBe(true);
    expect(columns.has("option1_name")).toBe(true);
    expect(rows[0]!.title).toBe("Silk Kurta");
    expect(rows[0]!.sku).toBe("K-1");
  });

  it("handles a BOM and CRLF line endings", () => {
    const { rows } = parseImportCsv("﻿title,price\r\nRice,149\r\nDal,99\r\n");
    expect(rows.map((r) => r.title)).toEqual(["Rice", "Dal"]);
  });

  it("rejects a CSV without a title or slug column", () => {
    expect(() => parseImportCsv("name,price\nRice,149")).toThrow(/title/);
  });

  it("rejects negative numbers instead of dropping the sign", () => {
    expect(() => parseMoneyPaise("-100", "price")).toThrow(/negative/);
    expect(() => parseCount("-5", "stock")).toThrow(/negative/);
    expect(parseMoneyPaise("₹ 1,499.00", "price")).toBe(149900);
    expect(parseMoneyPaise("Rs. 799", "price")).toBe(79900);
    expect(parseMoneyPaise("", "price")).toBeUndefined();
    expect(parseCount("12", "stock")).toBe(12);
    expect(() => parseCount("1.5", "stock")).toThrow(/whole/);
  });

  it("reports rows whose title gives no usable slug instead of skipping them silently", () => {
    const { groups, skipped } = groupImportRows([{ title: "🎉" }, { title: "Rice" }]);
    expect([...groups.keys()]).toEqual(["rice"]);
    expect(skipped).toHaveLength(1);
  });
});

describe("C6: re-importing keeps product data", () => {
  const vRed = new Types.ObjectId();
  const vBlue = new Types.ObjectId();
  const existing = {
    title: "Silk Saree",
    description: "Hand woven",
    images: [{ url: "https://cdn.example.com/a.jpg" }],
    status: "draft",
    categoryIds: [] as Types.ObjectId[],
    optionNames: ["Color"],
    gstRatePercent: 5,
    variants: [
      { _id: vRed, sku: "SAR-RED", options: new Map([["Color", "Red"]]), pricePaise: 249900, compareAtPaise: null, stock: 7, weightKg: 0.4, imageUrl: undefined },
      { _id: vBlue, sku: "SAR-BLU", options: new Map([["Color", "Blue"]]), pricePaise: 269900, compareAtPaise: null, stock: 3, weightKg: 0.4, imageUrl: undefined },
    ],
  };

  it("keeps variant ids, stock, status, images and description when those columns are absent", () => {
    const { rows, columns } = parseImportCsv("title,sku,price\nSilk Saree,SAR-RED,2599\nSilk Saree,SAR-BLU,2799");
    const plan = planImportProduct("silk-saree", rows, columns, existing) as any;
    expect(plan.variants.map((v: any) => String(v._id))).toEqual([String(vRed), String(vBlue)]);
    expect(plan.variants.map((v: any) => v.stock)).toEqual([7, 3]);
    expect(plan.variants.map((v: any) => v.pricePaise)).toEqual([259900, 279900]);
    expect(plan.variants[0].options).toEqual({ Color: "Red" });
    expect(plan.status).toBeUndefined();
    expect(plan.images).toBeUndefined();
    expect(plan.description).toBeUndefined();
  });

  it("matches variants by option combination when there is no SKU column", () => {
    const { rows, columns } = parseImportCsv("title,option1_name,option1_value,stock\nSilk Saree,Color,Blue,9");
    const plan = planImportProduct("silk-saree", rows, columns, existing) as any;
    const blue = plan.variants.find((v: any) => String(v._id) === String(vBlue));
    expect(blue.stock).toBe(9);
    expect(blue.sku).toBe("SAR-BLU");
    expect(blue.pricePaise).toBe(269900);
    // The variant missing from the file is kept, not deleted.
    expect(plan.variants.some((v: any) => String(v._id) === String(vRed))).toBe(true);
  });

  it("overwrites a field only when its column is present", () => {
    const { rows, columns } = parseImportCsv("title,sku,price,status,description\nSilk Saree,SAR-RED,2599,active,New text");
    const plan = planImportProduct("silk-saree", rows, columns, existing) as any;
    expect(plan.status).toBe("active");
    expect(plan.description).toBe("New text");
  });

  it("new products still need a price and default stock to 0", () => {
    const ok = parseImportCsv("title,price\nRice,149");
    const plan = planImportProduct("rice", ok.rows, ok.columns, null) as any;
    expect(plan.variants[0].stock).toBe(0);
    expect(plan.variants[0].pricePaise).toBe(14900);
    expect(plan.status).toBe("active");
    const bad = parseImportCsv("title,stock\nRice,10");
    expect(() => planImportProduct("rice", bad.rows, bad.columns, null)).toThrow(/price/i);
  });

  it("rejects an unknown status value", () => {
    const { rows, columns } = parseImportCsv("title,price,status\nRice,149,live");
    expect(() => planImportProduct("rice", rows, columns, null)).toThrow(/status/i);
  });
});
