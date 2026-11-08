import { Router, type Request, type Response, type NextFunction } from "express";
import { z, type ZodType } from "zod";
import { badRequest } from "../lib/errors.js";

export type AuthKind = "public" | "merchant" | "owner" | "platform" | "customer" | "customer-optional" | "internal";

export type RouteDef<B extends ZodType, Q extends ZodType, P extends ZodType> = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  auth: AuthKind;
  body?: B;
  query?: Q;
  params?: P;
  /** Set when the handler streams a file/redirects instead of returning JSON. */
  raw?: boolean;
  handler: (ctx: {
    req: Request;
    res: Response;
    body: z.infer<B>;
    query: z.infer<Q>;
    params: z.infer<P>;
  }) => Promise<unknown> | unknown;
};

type Registered = { method: string; path: string; summary: string; tag: string; auth: AuthKind; body?: ZodType; query?: ZodType; params?: ZodType };
export const routeRegistry: Registered[] = [];

/**
 * Creates an Express router whose routes are validated with Zod and also
 * registered for OpenAPI generation (the contract the frontend repo consumes).
 */
export function createModule(opts: { tag: string; basePath: string; guards: Partial<Record<AuthKind, (req: Request, res: Response, next: NextFunction) => void>> }) {
  const router = Router();
  function add<B extends ZodType = ZodType<undefined>, Q extends ZodType = ZodType<undefined>, P extends ZodType = ZodType<undefined>>(def: RouteDef<B, Q, P>) {
    routeRegistry.push({ method: def.method, path: opts.basePath + def.path, summary: def.summary, tag: opts.tag, auth: def.auth, body: def.body, query: def.query, params: def.params });
    const guard = opts.guards[def.auth];
    const handlers: any[] = [];
    if (guard) handlers.push(guard);
    handlers.push(async (req: Request, res: Response) => {
      const parse = (schema: ZodType | undefined, value: unknown, where: string) => {
        if (!schema) return undefined;
        const r = schema.safeParse(value);
        if (!r.success) throw badRequest(`Invalid ${where}`, z.flattenError(r.error));
        return r.data;
      };
      const body = parse(def.body, req.body, "request body");
      const query = parse(def.query, req.query, "query");
      const params = parse(def.params, req.params, "path parameters");
      const result = await def.handler({ req, res, body: body as any, query: query as any, params: params as any });
      if (def.raw || res.headersSent) return;
      res.status(def.method === "post" ? 201 : 200).json({ data: result ?? null });
    });
    (router as any)[def.method](opts.basePath + def.path, ...handlers);
  }
  return { router, add };
}

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
export const idParams = z.object({ id: objectId });
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
