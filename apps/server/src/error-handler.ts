import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ServerError } from "./errors";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ServerError) {
    return jsonError(
      c,
      {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined && { details: err.details }),
      },
      err.httpStatus,
    );
  }

  if (err instanceof HTTPException && err.status === 400) {
    return jsonError(c, { code: "BAD_REQUEST", message: err.message }, 400);
  }

  console.error(err);
  return jsonError(c, { code: "INTERNAL_ERROR", message: "Internal server error" }, 500);
}

function jsonError(
  c: Context,
  error: { code: string; message: string; details?: unknown },
  status: number,
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}
