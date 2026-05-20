import { Hono } from "hono";
import type { ToolConfirmationResult } from "@specra/agent-core";
import { BadRequestError } from "../errors";
import type { PermissionService } from "../permission-service";

interface PermissionBody {
  response?: unknown;
}

const VALID_RESPONSES = new Set<ToolConfirmationResult>([
  "approve_once",
  "approve_always",
  "deny",
]);

export function createPermissionRoutes(permissionService: PermissionService): Hono {
  const app = new Hono();

  app.post("/:id", async (c) => {
    const id = requiredParam(c.req.param("id"), "id");
    const body = await readPermissionBody(c.req.json());
    const response = readPermissionResponse(body);

    if (!permissionService.respond(id, response)) {
      throw new BadRequestError("Permission request not found or already resolved");
    }

    return c.json({ ok: true });
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function readPermissionBody(bodyPromise: Promise<unknown>): Promise<PermissionBody> {
  try {
    const body = await bodyPromise;
    if (!body || typeof body !== "object") {
      throw new BadRequestError("response is required");
    }

    return body;
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }

    throw new BadRequestError("Invalid JSON body");
  }
}

function readPermissionResponse(body: PermissionBody): ToolConfirmationResult {
  if (typeof body.response !== "string" || !VALID_RESPONSES.has(body.response as ToolConfirmationResult)) {
    throw new BadRequestError("response must be approve_once, approve_always, or deny");
  }

  return body.response as ToolConfirmationResult;
}
