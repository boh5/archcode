import type { MiddlewareHandler } from "hono";
import type { Logger } from "@archcode/agent-core";

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;
    const fields = {
      context: {
        method,
        path,
        status,
        durationMs: duration,
      },
    };

    if (status >= 500) {
      logger.error("http.request.completed", fields);
    } else {
      logger.info("http.request.completed", fields);
    }
  };
}
