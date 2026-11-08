import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodSchema } from "zod";
import { ApiError, notFound } from "./errors";

export const route = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function parse<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", detail);
  }
  return result.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not a UUID can't name anything, so it is a 404 rather than a 400. */
export function uuidParam(value: string, what: string): string {
  if (!UUID.test(value)) throw notFound(what);
  return value.toLowerCase();
}

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
