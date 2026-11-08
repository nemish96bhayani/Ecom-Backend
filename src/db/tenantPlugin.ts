import { Schema, Types } from "mongoose";
import { tenantContext } from "./tenantContext.js";

const QUERY_OPS = [
  "find",
  "findOne",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
] as const;

function scope(): { tenantId?: string; bypass: boolean } {
  const store = tenantContext.getStore();
  if (!store) throw new Error("Tenant isolation: query executed without tenant context");
  if (store.bypass) return { bypass: true };
  if (!store.tenantId) throw new Error("Tenant isolation: tenant context has no tenantId");
  return { tenantId: store.tenantId, bypass: false };
}

/**
 * Adds a required, indexed tenantId to the schema and forces every query, aggregate,
 * insert and bulk write to be scoped to the current tenant from AsyncLocalStorage.
 * A query without tenant context throws – isolation is enforced by default, not by memory.
 */
export const tenantIdField = { type: Schema.Types.ObjectId, required: true, index: true, immutable: true } as const;

export function tenantPlugin(schema: Schema) {
  if (!schema.path("tenantId")) schema.add({ tenantId: tenantIdField });

  for (const op of QUERY_OPS) {
    schema.pre(op as any, function (this: any) {
      const s = scope();
      if (!s.bypass) this.where({ tenantId: new Types.ObjectId(s.tenantId) });
    });
  }

  schema.pre("aggregate", function () {
    const s = scope();
    if (!s.bypass) this.pipeline().unshift({ $match: { tenantId: new Types.ObjectId(s.tenantId) } });
  });

  schema.pre("validate", function (this: any) {
    const s = scope();
    if (s.bypass) {
      if (!this.tenantId) throw new Error("Tenant isolation: tenantId required when bypassing context");
      return;
    }
    if (!this.tenantId) this.tenantId = new Types.ObjectId(s.tenantId);
    else if (String(this.tenantId) !== s.tenantId) throw new Error("Tenant isolation: tenantId mismatch on save");
  });

  schema.pre("insertMany", function (this: any, ...args: any[]) {
    const docs = args.find((a) => Array.isArray(a)) as any[] | undefined;
    const s = scope();
    if (s.bypass || !docs) return;
    for (const d of docs) {
      if (d.tenantId && String(d.tenantId) !== s.tenantId) throw new Error("Tenant isolation: tenantId mismatch");
      d.tenantId = new Types.ObjectId(s.tenantId);
    }
  });

  schema.pre("bulkWrite", function (this: any, ...args: any[]) {
    const ops = args.find((a) => Array.isArray(a)) as any[] | undefined;
    const s = scope();
    if (s.bypass || !ops) return;
    const tid = new Types.ObjectId(s.tenantId);
    for (const op of ops) {
      const k = Object.keys(op)[0]!;
      const body = op[k];
      if (k === "insertOne") body.document.tenantId = tid;
      else if (body.filter) body.filter.tenantId = tid;
    }
  });
}
