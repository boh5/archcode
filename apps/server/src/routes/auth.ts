import { Hono } from "hono";
import type {
  AuthStatus,
  LoginRequest,
  PasswordChangeRequest,
} from "@archcode/protocol";
import {
  AuthPasswordValidationError,
  AuthRateLimitError,
  InvalidAuthCredentialsError,
  type ServerAuthService,
} from "../server-auth-service";
import {
  assertMutationOrigin,
  clearSessionCookie,
  readSessionToken,
  writeSessionCookie,
} from "../auth-http";
import { BadRequestError, ServerError, UnauthorizedError } from "../errors";
import { readBoundedJsonBody } from "../request-body";

const AUTH_BODY_MAX_BYTES = 4 * 1024;

export interface CreateAuthRoutesOptions {
  readonly dev?: boolean;
}

export function createAuthRoutes(
  auth: ServerAuthService,
  options: CreateAuthRoutesOptions = {},
): Hono {
  const app = new Hono();

  app.get("/status", (c) => c.json(authStatus(auth, readSessionToken(c))));

  app.post("/login", async (c) => {
    assertMutationOrigin(c.req.raw, options);
    const input = parseLoginRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: AUTH_BODY_MAX_BYTES,
      label: "Login request",
    }));
    try {
      const session = await auth.login(input.password);
      writeSessionCookie(c, session);
      return c.json<AuthStatus>({ required: true, authenticated: true });
    } catch (error) {
      throw mapAuthError(error);
    }
  });

  app.post("/logout", (c) => {
    assertMutationOrigin(c.req.raw, options);
    auth.logout(readSessionToken(c));
    clearSessionCookie(c);
    return c.json<AuthStatus>({
      required: auth.authRequired,
      authenticated: false,
    });
  });

  app.put("/password", async (c) => {
    assertMutationOrigin(c.req.raw, options);
    if (auth.authRequired && !auth.authenticate(readSessionToken(c))) {
      throw new UnauthorizedError("Authentication required");
    }
    const input = parsePasswordChangeRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: AUTH_BODY_MAX_BYTES,
      label: "Password change request",
    }));
    try {
      const session = await auth.updatePassword(toPasswordUpdate(input));
      if (session === undefined) clearSessionCookie(c);
      else writeSessionCookie(c, session);
      return c.json<AuthStatus>({
        required: auth.authRequired,
        authenticated: auth.authRequired,
      });
    } catch (error) {
      throw mapPasswordUpdateError(error);
    }
  });

  return app;
}

function authStatus(auth: ServerAuthService, token: string | undefined): AuthStatus {
  return {
    required: auth.authRequired,
    authenticated: auth.authenticate(token),
  };
}

function parseLoginRequest(value: unknown): LoginRequest {
  const record = strictRecord(value, ["password"], "Login request");
  if (typeof record.password !== "string") {
    throw new BadRequestError("Login request password must be a string");
  }
  return { password: record.password };
}

function parsePasswordChangeRequest(value: unknown): PasswordChangeRequest {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new BadRequestError("Password change request must include an action");
  }
  switch (value.action) {
    case "set": {
      const record = strictRecord(value, ["action", "password"], "Set password request");
      if (typeof record.password !== "string") {
        throw new BadRequestError("Set password request password must be a string");
      }
      return { action: "set", password: record.password };
    }
    case "change": {
      const record = strictRecord(
        value,
        ["action", "currentPassword", "password"],
        "Change password request",
      );
      if (
        typeof record.currentPassword !== "string"
        || typeof record.password !== "string"
      ) {
        throw new BadRequestError(
          "Change password request passwords must be strings",
        );
      }
      return {
        action: "change",
        currentPassword: record.currentPassword,
        password: record.password,
      };
    }
    case "remove": {
      const record = strictRecord(
        value,
        ["action", "currentPassword"],
        "Remove password request",
      );
      if (typeof record.currentPassword !== "string") {
        throw new BadRequestError(
          "Remove password request currentPassword must be a string",
        );
      }
      return { action: "remove", currentPassword: record.currentPassword };
    }
    default:
      throw new BadRequestError("Unknown password change action");
  }
}

function toPasswordUpdate(input: PasswordChangeRequest): {
  currentPassword?: string;
  newPassword?: string;
} {
  switch (input.action) {
    case "set":
      return { newPassword: input.password };
    case "change":
      return {
        currentPassword: input.currentPassword,
        newPassword: input.password,
      };
    case "remove":
      return { currentPassword: input.currentPassword };
  }
}

function mapAuthError(error: unknown): Error {
  if (error instanceof InvalidAuthCredentialsError) {
    return new UnauthorizedError(error.message);
  }
  if (error instanceof AuthRateLimitError) {
    return new ServerError(
      "AUTH_RATE_LIMITED",
      error.message,
      429,
      { retryAfterSeconds: error.retryAfterSeconds },
    );
  }
  if (error instanceof AuthPasswordValidationError) {
    return new BadRequestError(error.message);
  }
  return error instanceof Error ? error : new Error("Authentication failed");
}

function mapPasswordUpdateError(error: unknown): Error {
  if (error instanceof InvalidAuthCredentialsError) {
    return new ServerError(
      "AUTH_CURRENT_PASSWORD_INVALID",
      error.message,
      403,
    );
  }
  return mapAuthError(error);
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new BadRequestError(`${label} must be an object`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new BadRequestError(`${label} contains unknown field "${unknown}"`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
