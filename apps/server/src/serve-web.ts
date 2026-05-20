import type { MiddlewareHandler } from "hono";
import { embeddedWebAssets, embeddedIndexPath } from "./web-manifest";

const contentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function contentTypeForPath(path: string): string {
  const extension = path.match(/\.[^.\/]+$/)?.[0]?.toLowerCase();
  return (extension && contentTypes.get(extension)) || "application/octet-stream";
}

export function createEmbeddedAssetHandler(): MiddlewareHandler {
  return async (c, next) => {
    const requestPath = new URL(c.req.url).pathname;

    if (requestPath === "/api" || requestPath.startsWith("/api/")) {
      await next();
      return;
    }

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return;
    }

    const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
    const assetPath = embeddedWebAssets.get(normalizedPath);
    if (assetPath) {
      return new Response(Bun.file(assetPath), {
        headers: { "Content-Type": contentTypeForPath(normalizedPath) },
      });
    }

    if (requestPath.startsWith("/assets/")) {
      return c.notFound();
    }

    if (embeddedIndexPath) {
      return new Response(Bun.file(embeddedIndexPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    await next();
  };
}
