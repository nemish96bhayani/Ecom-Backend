import { createModule } from "../http/route.js";
import { guards } from "../middleware/guards.js";

export const moduleFor = (tag: string, basePath: string) => createModule({ tag, basePath, guards });

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80);

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
