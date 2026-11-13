import { describe, it, expect } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createApp } from "../../src/app.js";
import { verifyAccess } from "../../src/lib/jwt.js";
import { errorHandler } from "../../src/middleware/errors.js";

/**
 * Regression test for the Critical upload finding (see reports/security-and-bugs.md, S1).
 * Runs without a database: the merchant guard rejects before any DB access.
 */
const app = createApp();

describe("S1: local upload route is authenticated", () => {
  it("rejects an unauthenticated PUT to /uploads/local/* with 401 (was: 200 arbitrary file write + stored XSS)", async () => {
    const res = await request(app)
      .put("/uploads/local/evil/poc.html")
      .set("content-type", "text/html")
      .send("<script>document.title='xss'</script>");
    expect(res.status).toBe(401);
  });

  it("rejects a PUT carrying a bogus bearer token", async () => {
    const res = await request(app)
      .put("/uploads/local/evil/poc.html")
      .set("authorization", "Bearer not-a-real-token")
      .set("content-type", "text/html")
      .send("x");
    expect(res.status).toBe(401);
  });
});

describe("S14: JWT verification is pinned to HS256", () => {
  it("rejects a token signed with a different algorithm, even with the right secret", () => {
    const token = jwt.sign({ sub: "x", kind: "platform" }, "test-access-secret", { algorithm: "HS512" });
    expect(() => verifyAccess(token)).toThrow();
  });

  it("still accepts a normal HS256 token", () => {
    const token = jwt.sign({ sub: "x", kind: "platform" }, "test-access-secret", { algorithm: "HS256" });
    expect(verifyAccess(token).sub).toBe("x");
  });
});

describe("S16: validation errors don't leak internal messages", () => {
  it("returns field names and a generic message", () => {
    const err = new mongoose.Error.ValidationError();
    err.addError("title", new mongoose.Error.ValidatorError({ message: "Path `title` is required.", path: "title" }));
    let status = 0;
    let body: any;
    const res: any = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) };
    errorHandler(err, { path: "/x" } as any, res, () => undefined);
    expect(status).toBe(400);
    expect(body.error.message).toBe("Some fields are invalid");
    expect(body.error.details.fieldErrors).toHaveProperty("title");
    expect(JSON.stringify(body)).not.toContain("Path `title`");
  });
});
