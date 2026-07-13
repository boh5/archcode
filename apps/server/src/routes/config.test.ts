import { describe, expect, mock, test } from "bun:test";
import {
  ConfigRevisionConflictError,
  ConfigSemanticValidationError,
  type ServerConfigService,
} from "@archcode/agent-core";
import { createConfigRoutes } from "./config";
import { errorHandler } from "../error-handler";

const snapshot = {
  config: { provider: {}, agents: {} },
  revision: "revision-1",
  configPath: "/Users/test/.archcode/config.json",
  restartRequired: false,
} as const;

function createService(overrides: Partial<Pick<ServerConfigService, "getSnapshot" | "save">> = {}) {
  return {
    getSnapshot: mock(async () => snapshot),
    save: mock(async () => snapshot),
    ...overrides,
  } as Pick<ServerConfigService, "getSnapshot" | "save">;
}

function createApp(service: Pick<ServerConfigService, "getSnapshot" | "save">) {
  const app = createConfigRoutes(service);
  app.onError(errorHandler);
  return app;
}

describe("config routes", () => {
  test("returns the global safe config snapshot", async () => {
    const service = createService();
    const response = await createApp(service).request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
  });

  test("rejects malformed PUT input with 400", async () => {
    const response = await createApp(createService()).request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Request body must be valid JSON" },
    });
  });

  test("maps complete configuration validation failures to 422", async () => {
    const service = createService({
      save: mock(async () => {
        throw new ConfigSemanticValidationError([{ path: "agents.engineer.model", message: "Unknown model" }]);
      }),
    });
    const response = await createApp(service).request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: "revision-1", config: snapshot.config }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "CONFIG_VALIDATION_ERROR",
        message: "Configuration validation failed",
        details: { issues: [{ path: "agents.engineer.model", message: "Unknown model" }] },
      },
    });
  });

  test("maps stale revisions to 409 without hiding revision details", async () => {
    const service = createService({
      save: mock(async () => {
        throw new ConfigRevisionConflictError("revision-1", "revision-2");
      }),
    });
    const response = await createApp(service).request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: "revision-1", config: snapshot.config }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "CONFIG_REVISION_CONFLICT",
        message: "The configuration changed on disk. Reload it before saving.",
        details: { expectedRevision: "revision-1", currentRevision: "revision-2" },
      },
    });
  });
});
