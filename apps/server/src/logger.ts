import type { MiddlewareHandler } from "hono";
import { formatIsoTime } from "@specra/utils";

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;
    const time = formatIsoTime(new Date(start).toISOString());
    const log = status >= 500 ? console.error : console.info;

    log(`[${time}] ${method} ${path} ${status} ${duration}ms`);
  };
}
