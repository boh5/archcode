import { Hono } from "hono";
import {
  ConfigRevisionConflictError,
  ConfigSemanticValidationError,
} from "@archcode/agent-core";
import type { ServerConfigSnapshot, UpdateServerConfigRequest, UpdateServerConfigResponse } from "@archcode/protocol";
import {
  BadRequestError,
  ConfigRevisionConflictHttpError,
  ConfigValidationHttpError,
} from "../errors";

/** Global server configuration. This route intentionally has no project slug. */
export interface ConfigServicePort {
  getSnapshot(): Promise<ServerConfigSnapshot>;
  save(request: UpdateServerConfigRequest): Promise<UpdateServerConfigResponse>;
}

export function createConfigRoutes(configService: ConfigServicePort): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json(await configService.getSnapshot()));

  app.put("/", async (c) => {
    const input = await parseUpdateRequest(c.req.raw);
    try {
      return c.json(await configService.save(input));
    } catch (error) {
      if (error instanceof ConfigRevisionConflictError) {
        throw new ConfigRevisionConflictHttpError(error.expectedRevision, error.currentRevision);
      }
      if (error instanceof ConfigSemanticValidationError) {
        throw new ConfigValidationHttpError(error.issues);
      }
      throw error;
    }
  });

  return app;
}

async function parseUpdateRequest(request: Request): Promise<UpdateServerConfigRequest> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("Request body must be an object");
  }
  const requestValue = value as Record<string, unknown>;
  if (typeof requestValue.expectedRevision !== "string" || !requestValue.config || typeof requestValue.config !== "object" || Array.isArray(requestValue.config)) {
    throw new BadRequestError("Request body must include expectedRevision and config");
  }
  return requestValue as unknown as UpdateServerConfigRequest;
}
