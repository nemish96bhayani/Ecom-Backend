import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../config/env.js";
import { runAsTenant, runWithoutTenant } from "../db/tenantContext.js";
import { Product } from "../models/catalog.js";
import { Domain, Tenant } from "../models/platform.js";
import { timingSafeEqualStr } from "../lib/crypto.js";

export const feedToken = (tenantId: string) => crypto.createHmac("sha256", env.VAULT_KEY).update(`feed:${tenantId}`).digest("hex").slice(0, 32);

const router = Router();
export default router;

const clean = (s: string) => (s ?? "").replace(/[\t\n\r]+/g, " ").replace(/"/g, "'").slice(0, 4900);

/** Public product feeds (token-protected URL) for Meta Catalog and Google Merchant Center. */
router.get("/api/v1/feeds/:tenantId/:token/:file", async (req, res) => {
  const { tenantId, token, file } = req.params;
  if (!/^[a-f0-9]{24}$/.test(tenantId) || !timingSafeEqualStr(token, feedToken(tenantId))) return res.status(404).end();
  const [tenant, domain] = await runWithoutTenant("feed", () =>
    Promise.all([Tenant.findById(tenantId).lean(), Domain.findOne({ tenantId, isPrimary: true }).lean().then((d) => d ?? Domain.findOne({ tenantId, kind: "subdomain" }).lean())]),
  );
  if (!tenant || tenant.status !== "active" || !domain) return res.status(404).end();
  const base = `https://${domain.hostname}`;
  const products = await runAsTenant(tenantId, () => Product.find({ status: "active" }).lean());
  const header = ["id", "item_group_id", "title", "description", "availability", "condition", "price", "sale_price", "link", "image_link", "brand"];
  const rows = products.flatMap((p) =>
    p.variants.map((v: any) => {
      const sale = v.compareAtPaise && v.compareAtPaise > v.pricePaise;
      return [
        v.sku,
        String(p._id),
        clean(p.title),
        clean(p.description || p.title),
        v.stock > 0 ? "in stock" : "out of stock",
        "new",
        `${((sale ? v.compareAtPaise : v.pricePaise) / 100).toFixed(2)} INR`,
        sale ? `${(v.pricePaise / 100).toFixed(2)} INR` : "",
        `${base}/products/${p.slug}?variant=${v._id}`,
        v.imageUrl ?? p.images?.[0]?.url ?? "",
        clean(p.brand ?? tenant.name),
      ];
    }),
  );
  if (file === "google.tsv") {
    res.type("text/tab-separated-values").send([header, ...rows].map((r) => r.join("\t")).join("\n"));
  } else if (file === "meta.csv") {
    res.type("text/csv").send([header, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n"));
  } else res.status(404).end();
});
