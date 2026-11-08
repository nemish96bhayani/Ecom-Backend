/** Writes openapi/openapi.json – the contract the frontend repo generates its API client from. */
import { writeFileSync, mkdirSync } from "node:fs";
process.env.MONGO_URL ??= "mongodb://localhost/unused";
const { createApp } = await import("../src/app.js");
const { buildOpenApi } = await import("../src/http/openapi.js");
createApp(); // registers every route
mkdirSync("openapi", { recursive: true });
const doc = buildOpenApi();
writeFileSync("openapi/openapi.json", JSON.stringify(doc, null, 2));
console.log(`openapi/openapi.json written (${Object.keys(doc.paths).length} paths)`);
process.exit(0);
