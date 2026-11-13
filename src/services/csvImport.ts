import { parse as parseCsv, CsvError } from "csv-parse/sync";
import { badRequest } from "../lib/errors.js";
import { slugify } from "../modules/_shared.js";

/**
 * Pure helpers for the product CSV import (POST /admin/products/import). Columns:
 * title, slug, description, category, sku, option1_name, option1_value, option2_name, option2_value,
 * option3_name, option3_value, price, compare_at_price, stock, weight_kg, hsn, gst_rate, image_url, status
 *
 * Re-importing must not clobber data: a field is only overwritten when its column is in the header
 * and the cell is filled, and existing variants keep their _id (carts and orders point at it).
 */
export type CsvRow = Record<string, string>;

const normHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_");

export function parseImportCsv(csv: string): { rows: CsvRow[]; columns: Set<string> } {
  let header: string[] = [];
  let rows: CsvRow[];
  try {
    rows = parseCsv(csv, {
      columns: (h: string[]) => (header = h.map(normHeader)),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
    });
  } catch (e) {
    if (e instanceof CsvError) throw badRequest(`The CSV couldn't be read: ${e.message}`);
    throw e;
  }
  const columns = new Set(header);
  if (!columns.has("title") && !columns.has("slug")) throw badRequest("The CSV needs a title column (headers are matched ignoring case)");
  if (!rows.length) throw badRequest("The CSV has no rows");
  return { rows, columns };
}

/** Rows with the same slug (or title) become variants of one product. */
export function groupImportRows(rows: CsvRow[]) {
  const groups = new Map<string, CsvRow[]>();
  const skipped: { row: string; message: string }[] = [];
  rows.forEach((r, i) => {
    const key = slugify(r.slug || r.title || "");
    if (!key) {
      skipped.push({ row: r.title || r.slug || `line ${i + 2}`, message: "Title or slug has no letters or numbers to build a URL from" });
      return;
    }
    groups.set(key, [...(groups.get(key) ?? []), r]);
  });
  return { groups, skipped };
}

const blank = (v: string | undefined) => v === undefined || v.trim() === "";

function cleanNumeric(val: string, field: string) {
  const s = val
    .trim()
    .replace(/^(rs\.?|inr|₹)\s*/i, "")
    .replace(/[₹,\s]/g, "");
  if (s.startsWith("-")) throw new Error(`${field} can't be negative (${val})`);
  if (!/^\d*\.?\d+$/.test(s)) throw new Error(`${field} isn't a number (${val})`);
  return Number(s);
}

/** Rupee amount in a cell → integer paise. Blank → undefined. */
export function parseMoneyPaise(val: string | undefined, field: string): number | undefined {
  if (blank(val)) return undefined;
  return Math.round(cleanNumeric(val!, field) * 100);
}

/** Plain non-negative number (weight, GST rate). Blank → undefined. */
export function parseDecimal(val: string | undefined, field: string): number | undefined {
  if (blank(val)) return undefined;
  return cleanNumeric(val!, field);
}

/** Whole non-negative count (stock). Blank → undefined. */
export function parseCount(val: string | undefined, field: string): number | undefined {
  if (blank(val)) return undefined;
  const n = cleanNumeric(val!, field);
  if (!Number.isInteger(n)) throw new Error(`${field} must be a whole number (${val})`);
  return n;
}

const urlsOf = (cell: string | undefined) =>
  (cell ? cell.split(/[\s,;|]+/) : []).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));

const optionsOf = (r: CsvRow) => {
  const o: Record<string, string> = {};
  for (const n of [1, 2, 3]) {
    const name = r[`option${n}_name`];
    const value = r[`option${n}_value`];
    if (name && value) o[name] = value;
  }
  return o;
};

const optionKey = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const toPlainOptions = (o: unknown): Record<string, string> =>
  o instanceof Map ? Object.fromEntries(o) : ((o as Record<string, string> | undefined) ?? {});

export type ExistingVariant = {
  _id?: unknown;
  sku?: string | null;
  options?: unknown;
  pricePaise?: number | null;
  compareAtPaise?: number | null;
  stock?: number | null;
  weightKg?: number | null;
  imageUrl?: string | null;
};
export type ExistingProduct = { variants: ExistingVariant[]; categoryIds?: unknown[] };

const STATUSES = ["draft", "active", "archived"];

/**
 * What to write for one product. For a new product this is a full document; for an existing one
 * it only contains the fields the CSV actually provides (pass it to doc.set()).
 */
export function planImportProduct(
  slug: string,
  group: CsvRow[],
  columns: Set<string>,
  existing: ExistingProduct | null,
  categoryId?: unknown,
) {
  const first = group[0]!;
  const has = (c: string) => columns.has(c) && !blank(first[c]);
  const hasOptionColumns = [1, 2, 3].some((n) => columns.has(`option${n}_name`));

  const pool = [...(existing?.variants ?? [])];
  const take = (v: ExistingVariant | undefined) => {
    if (v) pool.splice(pool.indexOf(v), 1);
    return v;
  };
  const findExisting = (r: CsvRow, options: Record<string, string>) => {
    if (!existing) return undefined;
    if (r.sku) {
      const bySku = pool.find((v) => v.sku === r.sku);
      if (bySku) return take(bySku);
    }
    if (Object.keys(options).length) {
      const key = optionKey(options);
      const byOpts = pool.find((v) => optionKey(toPlainOptions(v.options)) === key);
      if (byOpts) return take(byOpts);
    }
    if (group.length === 1 && existing.variants.length === 1 && !r.sku && pool.length === 1) return take(pool[0]);
    return undefined;
  };

  const variants = group.map((r, i) => {
    const options = optionsOf(r);
    const label = r.sku || `${slug} row ${i + 1}`;
    const price = parseMoneyPaise(r.price, "Price");
    const compare = parseMoneyPaise(r.compare_at_price, "Compare-at price");
    const stock = parseCount(r.stock, "Stock");
    const weight = parseDecimal(r.weight_kg, "Weight");
    const image = urlsOf(r.image_url)[0];
    const old = findExisting(r, options);
    if (!old && price === undefined) throw new Error(`Price is missing or invalid for ${label}`);
    return {
      ...(old?._id ? { _id: old._id } : {}),
      sku: r.sku || old?.sku || `${slug}-${Math.random().toString(36).slice(2, 7)}`,
      options: hasOptionColumns || !old ? options : toPlainOptions(old.options),
      pricePaise: price ?? old!.pricePaise!,
      compareAtPaise: compare ?? (old ? (old.compareAtPaise ?? null) : null),
      stock: stock ?? old?.stock ?? 0,
      weightKg: weight ?? (old ? (old.weightKg ?? null) : null),
      imageUrl: image ?? old?.imageUrl ?? undefined,
    };
  });
  // Variants the file doesn't mention are kept (deleting them would break carts and restocks).
  const allVariants = [...variants, ...pool.map((v) => ({ ...v, options: toPlainOptions(v.options) }))];

  const status = has("status") ? first.status!.toLowerCase() : undefined;
  if (status !== undefined && !STATUSES.includes(status))
    throw new Error(`Status must be draft, active or archived (got "${first.status}")`);
  const gst = parseDecimal(first.gst_rate, "GST rate");
  if (gst !== undefined && gst > 40) throw new Error(`GST rate looks wrong (${first.gst_rate})`);
  const images = Array.from(new Set(group.flatMap((r) => urlsOf(r.image_url)))).map((url) => ({ url }));
  const optionNames = Array.from(
    new Set(group.flatMap((r) => [r.option1_name, r.option2_name, r.option3_name].filter(Boolean) as string[])),
  );

  if (!existing) {
    return {
      title: first.title || slug,
      slug,
      description: first.description ?? "",
      categoryIds: categoryId ? [categoryId] : [],
      images,
      optionNames,
      variants: allVariants,
      hsn: first.hsn || undefined,
      gstRatePercent: gst ?? 5,
      status: status ?? "active",
    };
  }

  const set: Record<string, unknown> = { variants: allVariants };
  if (has("title")) set.title = first.title;
  if (has("description")) set.description = first.description;
  if (has("hsn")) set.hsn = first.hsn;
  if (gst !== undefined) set.gstRatePercent = gst;
  if (status !== undefined) set.status = status;
  if (images.length) set.images = images;
  if (hasOptionColumns && optionNames.length) set.optionNames = optionNames;
  if (categoryId) {
    const ids = existing.categoryIds ?? [];
    if (!ids.some((c) => String(c) === String(categoryId))) set.categoryIds = [...ids, categoryId];
  }
  return set;
}
