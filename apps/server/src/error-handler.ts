import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createConsoleLogger, type Logger } from "@archcode/agent-core";
import { ServerError } from "./errors";

export function errorHandler(
  err: Error,
  c: Context,
  logger: Logger = createConsoleLogger({ level: "info", module: "server.http" }),
): Response {
  if (err instanceof ServerError) {
    if (err.httpStatus >= 500) {
      logger.error("http.request.failed", {
        context: requestFailureContext(c, err.httpStatus),
        meta: {
          errorName: err.name,
          errorCode: err.code,
        },
      });
    }
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

  logger.error("http.request.failed", {
    error: err,
    context: requestFailureContext(c, 500),
    meta: {
      errorName: err.name,
      errorCode: "INTERNAL_ERROR",
    },
  });
  return jsonError(c, { code: "INTERNAL_ERROR", message: "Internal server error" }, 500);
}

function requestFailureContext(
  context: Context,
  status: number,
): Record<string, unknown> {
  return {
    method: context.req.method,
    path: context.req.path,
    status,
  };
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
