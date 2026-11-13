import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: "This endpoint doesn't exist" } });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})
      .filter((k) => k !== "tenantId")
      .join(", ");
    return res.status(409).json({ error: { code: "duplicate", message: `That ${field || "value"} is already in use` } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    // Return which fields failed, not Mongoose's internal message text.
    const fieldErrors = Object.fromEntries(Object.keys(err.errors).map((k) => [k, ["Invalid value"]]));
    return res.status(400).json({ error: { code: "validation", message: "Some fields are invalid", details: { fieldErrors } } });
  }
  if (err instanceof mongoose.Error.CastError) {
    // e.g. a malformed ObjectId in a filter: the client sent a bad value, not a server fault.
    return res.status(400).json({ error: { code: "bad_request", message: `Invalid value for ${err.path}` } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "Request body is not valid JSON" } });
  }
  logger.error({ err, path: req.path }, "Unhandled error");
  res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side. Try again in a minute." } });
}
