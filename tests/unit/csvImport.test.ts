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
