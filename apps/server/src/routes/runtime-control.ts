import { Hono } from "hono";
import { RuntimeDataRequestError } from "@archcode/agent-core";
import type {
  RuntimeDataDeleteResponse,
  RuntimeDataInspectionResponse,
  RuntimeStatus,
} from "@archcode/protocol";

import { BadRequestError, ServerError } from "../errors";
import { readBoundedJsonBody } from "../request-body";

const RUNTIME_DATA_DELETE_BODY_MAX_BYTES = 64 * 1024;

export interface RuntimeControlCoordinatorPort {
  getRuntimeStatus(): RuntimeStatus;
  retryRuntime(): Promise<RuntimeStatus>;
  inspectRuntimeData(): Promise<RuntimeDataInspectionResponse>;
  deleteRuntimeData(projectSlugs: readonly string[]): Promise<RuntimeDataDeleteResponse>;
}

export function createRuntimeControlRoutes(
  coordinator: RuntimeControlCoordinatorPort,
): { runtime: Hono; runtimeData: Hono } {
  const runtime = new Hono();
  runtime.get("/status", (c) => c.json(coordinator.getRuntimeStatus()));
  runtime.post("/retry", async (c) => c.json(await coordinator.retryRuntime()));

  const runtimeData = new Hono();
  runtimeData.get("/", async (c) => c.json(await coordinator.inspectRuntimeData()));
  runtimeData.delete("/", async (c) => {
    const body = parseDeleteRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: RUNTIME_DATA_DELETE_BODY_MAX_BYTES,
      label: "Runtime data delete request",
    }));
    try {
      return c.json(await coordinator.deleteRuntimeData(body.projectSlugs));
    } catch (error) {
      throw mapRuntimeDataRequestError(error);
    }
  });

  return { runtime, runtimeData };
}

function parseDeleteRequest(value: unknown): { projectSlugs: string[] } {
  if (!isRecord(value)) {
    throw new BadRequestError("Runtime data delete request must be an object");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "projectSlugs") {
    throw new BadRequestError(
      "Runtime data delete request must contain only projectSlugs",
    );
  }
  if (!Array.isArray(value.projectSlugs) || value.projectSlugs.some(
    (projectSlug) => typeof projectSlug !== "string" || projectSlug.length === 0,
  )) {
    throw new BadRequestError("projectSlugs must be an array of non-empty strings");
  }
  return { projectSlugs: value.projectSlugs };
}

function mapRuntimeDataRequestError(error: unknown): Error {
  if (!(error instanceof RuntimeDataRequestError)) {
    return error instanceof Error ? error : new Error("Runtime data operation failed");
  }
  const status = error.code === "PROJECT_NOT_REGISTERED"
    ? 404
    : error.code === "PROJECT_HAS_NO_ISSUES" || error.code === "DELETE_TARGET_UNSAFE"
      ? 409
      : 400;
  return new ServerError(
    error.code,
    error.message,
    status,
    error.projectSlug === undefined ? undefined : { projectSlug: error.projectSlug },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
