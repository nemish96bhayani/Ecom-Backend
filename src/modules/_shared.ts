import { z } from "zod";
import { customAlphabet } from "nanoid";
import { createModule } from "../http/route.js";
import { guards } from "../middleware/guards.js";

export const moduleFor = (tag: string, basePath: string) => createModule({ tag, basePath, guards });

/**
 * URL slug. ASCII and Latin text gives exactly the same result as before (accents dropped, other
 * Latin letters such as ß removed); letters and numbers from other scripts (Hindi, Tamil, …) are kept.
 * Can return "" (e.g. emoji only) – use slugOrId when a slug is required.
 */
export const slugify = (s: string) =>
  Array.from(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
      .normalize("NFC")
      .replace(/[^\P{Script=Latin}a-z]/gu, "")
      .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-"),
  )
    .slice(0, 80)
    .join("");

const shortId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
/** slugify with a short random fallback, so a title made only of symbols still gets a valid slug. */
export const slugOrId = (s: string) => slugify(s) || `item-${shortId()}`;

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Zod 4 `.partial()` still fills `.default()` values, so a PATCH would reset fields the client
 * never sent. Keep only the top-level keys present in the raw request body.
 */
export function sentKeys<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => Object.prototype.hasOwnProperty.call(raw, k))) as Partial<T>;
}

/** Query-string boolean: "true"/"1"/"yes" → true, "false"/"0"/"no" → false (z.coerce.boolean turns "false" into true). */
export const queryBool = z.stringbool();

/** Optional body date that can be cleared: null or "" → null (z.coerce.date would turn null into 1 Jan 1970). */
export const clearableDate = z.union([z.literal("").transform(() => null), z.null(), z.coerce.date()]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Date filter start: a bare YYYY-MM-DD means 00:00 IST that day. */
export const queryDateFrom = z.preprocess(
  (v) => (typeof v === "string" && DATE_ONLY.test(v) ? `${v}T00:00:00.000+05:30` : v),
  z.coerce.date(),
);
/** Date filter end: a bare YYYY-MM-DD means the end of that day in IST (so the last day isn't dropped). */
export const queryDateTo = z.preprocess(
  (v) => (typeof v === "string" && DATE_ONLY.test(v) ? `${v}T23:59:59.999+05:30` : v),
  z.coerce.date(),
);
