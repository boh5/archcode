import { Hono } from "hono";
import {
  ConfigInitializationConflictError,
  ConfigSemanticValidationError,
} from "@archcode/agent-core";
import type {
  CompleteSetupRequest,
  CompleteSetupResponse,
  SetupProviderAdapterCatalogResponse,
} from "@archcode/protocol";
import { writeSessionCookie } from "../auth-http";
import { assertMutationOrigin } from "../auth-http";
import type { AuthSession } from "../server-auth-service";
import { AuthPasswordValidationError } from "../server-auth-service";
import {
  BadRequestError,
  ConfigValidationHttpError,
  ServerError,
  UnauthorizedError,
} from "../errors";
import { readBoundedJsonBody } from "../request-body";

const SETUP_BODY_MAX_BYTES = 1024 * 1024;

export interface CompleteSetupResult {
  readonly response: CompleteSetupResponse;
  readonly session?: AuthSession;
}

export interface SetupCoordinatorPort {
  getSetupProviderAdapterCatalog(
    authorization: string | undefined,
  ): SetupProviderAdapterCatalogResponse;
  completeSetup(
    authorization: string | undefined,
    request: CompleteSetupRequest,
  ): Promise<CompleteSetupResult>;
}

export function createSetupRoutes(
  coordinator: SetupCoordinatorPort,
  options: { readonly dev?: boolean } = {},
): Hono {
  const app = new Hono();

  app.get("/provider-adapters", (c) => c.json(
    coordinator.getSetupProviderAdapterCatalog(c.req.header("Authorization")),
  ));

  app.post("/", async (c) => {
    assertMutationOrigin(c.req.raw, options);
    const input = parseCompleteSetupRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: SETUP_BODY_MAX_BYTES,
      label: "Setup request",
    }));
    try {
      const result = await coordinator.completeSetup(
        c.req.header("Authorization"),
        input,
      );
      if (result.session !== undefined) writeSessionCookie(c, result.session);
      return c.json(result.response);
    } catch (error) {
      if (error instanceof ConfigSemanticValidationError) {
        throw new ConfigValidationHttpError(error.issues);
      }
      if (error instanceof ConfigInitializationConflictError) {
        throw new ServerError(
          "SETUP_CONFLICT",
          "Global configuration was created by another process",
          409,
        );
      }
      if (error instanceof AuthPasswordValidationError) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  });

  return app;
}

export function requireSetupGrant(authorized: boolean): void {
  if (!authorized) {
    throw new UnauthorizedError("A valid one-time Setup Grant is required");
  }
}

function parseCompleteSetupRequest(value: unknown): CompleteSetupRequest {
  if (!isRecord(value)) throw new BadRequestError("Setup request must be an object");
  const allowed = new Set(["config", "requireLogin", "password"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new BadRequestError(`Setup request contains unknown field "${unknown}"`);
  }
  if (!isRecord(value.config)) {
    throw new BadRequestError("Setup request config must be an object");
  }
  if (Object.hasOwn(value.config, "auth")) {
    throw new BadRequestError(
      "Setup request config cannot contain server authentication state",
    );
  }
  if (typeof value.requireLogin !== "boolean") {
    throw new BadRequestError("Setup request requireLogin must be a boolean");
  }
  if (value.requireLogin) {
    if (typeof value.password !== "string") {
      throw new BadRequestError(
        "Setup request password is required when login is enabled",
      );
    }
    return {
      config: value.config as unknown as CompleteSetupRequest["config"],
      requireLogin: true,
      password: value.password,
    };
  }
  if (value.password !== undefined) {
    throw new BadRequestError(
      "Setup request password must be omitted when login is disabled",
    );
  }
  return {
    config: value.config as unknown as CompleteSetupRequest["config"],
    requireLogin: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
