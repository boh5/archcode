import { describe, expect, mock, test } from "bun:test";
import { RuntimeDataRequestError } from "@archcode/agent-core";

import { errorHandler } from "../error-handler";
import { createRuntimeControlRoutes } from "./runtime-control";

function createCoordinator() {
  return {
    getRuntimeStatus: mock(() => ({
      state: "error" as const,
      error: { message: "safe", recoveryAllowed: true },
    })),
    retryRuntime: mock(async () => ({ state: "ready" as const })),
    inspectRuntimeData: mock(async () => ({ projects: [] })),
    deleteRuntimeData: mock(async (projectSlugs: readonly string[]) => ({
      results: projectSlugs.map((projectSlug) => ({
        projectSlug,
        status: "deleted" as const,
      })),
      runtime: { state: "ready" as const },
    })),
  };
}

describe("runtime control routes", () => {
  test("returns Runtime status and retries through the coordinator", async () => {
    const coordinator = createCoordinator();
    const routes = createRuntimeControlRoutes(coordinator);
    routes.runtime.onError(errorHandler);

    expect(await (await routes.runtime.request("/status")).json()).toEqual({
      state: "error",
      error: { message: "safe", recoveryAllowed: true },
    });
    expect(await (await routes.runtime.request("/retry", { method: "POST" })).json())
      .toEqual({ state: "ready" });
    expect(coordinator.retryRuntime).toHaveBeenCalledTimes(1);
  });

  test("inspects and deletes only with the strict projectSlugs request", async () => {
    const coordinator = createCoordinator();
    const routes = createRuntimeControlRoutes(coordinator);
    routes.runtimeData.onError(errorHandler);

    expect(await (await routes.runtimeData.request("/")).json()).toEqual({ projects: [] });
    const response = await routes.runtimeData.request("/", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSlugs: ["alpha"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ projectSlug: "alpha", status: "deleted" }],
      runtime: { state: "ready" },
    });
    expect(coordinator.deleteRuntimeData).toHaveBeenCalledWith(["alpha"]);

    for (const body of [
      { projectSlugs: ["alpha"], path: "/tmp/runtime" },
      { path: "/tmp/runtime" },
      { projectSlugs: "alpha" },
      { projectSlugs: [""] },
    ]) {
      const rejected = await routes.runtimeData.request("/", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(rejected.status).toBe(400);
    }
  });

  test("maps Runtime data preflight errors without exposing filesystem causes", async () => {
    const coordinator = createCoordinator();
    coordinator.deleteRuntimeData = mock(async () => {
      throw new RuntimeDataRequestError(
        "DELETE_TARGET_UNSAFE",
        "The project Runtime tree is not safe to delete.",
        "alpha",
      );
    });
    const routes = createRuntimeControlRoutes(coordinator);
    routes.runtimeData.onError(errorHandler);

    const response = await routes.runtimeData.request("/", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSlugs: ["alpha"] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "DELETE_TARGET_UNSAFE",
        message: "The project Runtime tree is not safe to delete.",
        details: { projectSlug: "alpha" },
      },
    });
  });

  test("preserves empty and duplicate slug validation errors from the service", async () => {
    const coordinator = createCoordinator();
    coordinator.deleteRuntimeData = mock(async (projectSlugs: readonly string[]) => {
      if (projectSlugs.length === 0) {
        throw new RuntimeDataRequestError(
          "EMPTY_PROJECT_SLUGS",
          "At least one project slug is required.",
        );
      }
      throw new RuntimeDataRequestError(
        "DUPLICATE_PROJECT_SLUG",
        "Project slugs must not contain duplicates.",
      );
    });
    const routes = createRuntimeControlRoutes(coordinator);
    routes.runtimeData.onError(errorHandler);

    for (const projectSlugs of [[], ["alpha", "alpha"]]) {
      const response = await routes.runtimeData.request("/", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectSlugs }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(
        projectSlugs.length === 0 ? "EMPTY_PROJECT_SLUGS" : "DUPLICATE_PROJECT_SLUG",
      );
    }
  });
});
