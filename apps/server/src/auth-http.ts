import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AuthSession } from "./server-auth-service";
import { ServerError } from "./errors";

export const AUTH_SESSION_COOKIE = "archcode_session";

export function readSessionToken(context: Context): string | undefined {
  return readSessionTokenFromRequest(context.req.raw);
}

export function readSessionTokenFromRequest(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === AUTH_SESSION_COOKIE) return valueParts.join("=") || undefined;
  }
  return undefined;
}

export function writeSessionCookie(context: Context, session: AuthSession): void {
  setCookie(context, AUTH_SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: requiresSecureCookie(context.req.raw),
    maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
  });
}

export function clearSessionCookie(context: Context): void {
  deleteCookie(context, AUTH_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: requiresSecureCookie(context.req.raw),
  });
}

export function assertMutationOrigin(
  request: Request,
  options: { readonly dev?: boolean } = {},
): void {
  const originHeader = request.headers.get("origin");
  if (originHeader === null) {
    throw new ServerError(
      "CSRF_ORIGIN_INVALID",
      "A same-origin Origin header is required",
      403,
    );
  }

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    throw invalidOrigin();
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw invalidOrigin();
  }

  const requestUrl = new URL(request.url);
  if (origin.host === requestUrl.host) return;
  if (
    options.dev
    && isLoopback(origin.hostname)
    && origin.port === "5173"
    && isLoopback(requestUrl.hostname)
  ) {
    return;
  }
  throw invalidOrigin();
}

function requiresSecureCookie(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || !isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

function invalidOrigin(): ServerError {
  return new ServerError(
    "CSRF_ORIGIN_INVALID",
    "Request Origin does not match this ArchCode server",
    403,
  );
}
