import { connectDb } from "../src/db/connect.js";
import { Tenant, Domain } from "../src/models/platform.js";

await connectDb();
const tenants = await Tenant.find().lean();
console.log("Found tenants:", tenants.map((t) => ({ id: t._id, name: t.name, slug: t.slug })));

for (const t of tenants) {
  const host = `${t.slug}.localhost`;
  const existing = await Domain.findOne({ tenantId: t._id, hostname: host });
  if (!existing) {
    await Domain.create({
      tenantId: t._id,
      hostname: host,
      kind: "subdomain",
      status: "active",
      isPrimary: false,
    });
    console.log(`Created domain mapping: ${host} -> ${t.name}`);
  }
}

import { redis } from "../src/lib/redis.js";
await redis.flushall();
console.log("Redis cache flushed successfully.");
const allDomains = await Domain.find().lean();
console.log("All registered domains:", allDomains.map((d) => d.hostname));
process.exit(0);
