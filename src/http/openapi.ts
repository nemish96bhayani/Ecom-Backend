import { z } from "zod";
import { routeRegistry } from "./route.js";

const toSchema = (s: any) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;

/** Builds an OpenAPI 3.1 document from every route registered through createModule(). */
export function buildOpenApi() {
  const paths: Record<string, any> = {};
  for (const r of routeRegistry) {
    const oaPath = r.path.replace(/:(\w+)/g, "{$1}");
    const op: any = {
      tags: [r.tag],
      summary: r.summary,
      operationId: `${r.method}_${oaPath.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(/_+$/, ""),
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: {} } } } } } },
    };
    if (r.auth !== "public") op.security = r.auth.startsWith("customer") || r.auth === "internal" ? [{ storeProxy: [] }] : [{ bearer: [] }];
    const parameters: any[] = [];
    for (const [where, schema] of [["path", r.params], ["query", r.query]] as const) {
      if (!schema) continue;
      const js = toSchema(schema) as any;
      for (const [name, prop] of Object.entries<any>(js.properties ?? {})) {
        parameters.push({ name, in: where, required: where === "path" || (js.required ?? []).includes(name), schema: prop });
      }
    }
    if (parameters.length) op.parameters = parameters;
    if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: toSchema(r.body) } } };
    paths[oaPath] = { ...(paths[oaPath] ?? {}), [r.method]: op };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Multi-tenant E-commerce Platform API", version: "1.0.0" },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        storeProxy: { type: "apiKey", in: "header", name: "x-internal-secret" },
      },
    },
    paths,
  };
}
