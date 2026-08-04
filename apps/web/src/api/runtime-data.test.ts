import { afterEach, describe, expect, mock, test } from "bun:test";
import { deleteRuntimeData, inspectRuntimeData, retryRuntime } from "./runtime-data";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runtime data control-plane API", () => {
  test("inspects Runtime data without a request body", async () => {
    globalThis.fetch = mock(async () => Response.json({ projects: [] })) as unknown as typeof fetch;

    await expect(inspectRuntimeData()).resolves.toEqual({ projects: [] });
    expect(fetch).toHaveBeenCalledWith("/api/runtime-data", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  test("deletes only server-resolved project slugs", async () => {
    globalThis.fetch = mock(async () => Response.json({
      results: [{ projectSlug: "broken", status: "deleted" }],
      runtime: { state: "ready" },
    })) as unknown as typeof fetch;

    await expect(deleteRuntimeData({ projectSlugs: ["broken"] })).resolves.toEqual({
      results: [{ projectSlug: "broken", status: "deleted" }],
      runtime: { state: "ready" },
    });

    expect(fetch).toHaveBeenCalledWith("/api/runtime-data", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ projectSlugs: ["broken"] }),
      credentials: "same-origin",
    }));
  });

  test("retries Runtime through the control plane", async () => {
    globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch;

    await retryRuntime();

    expect(fetch).toHaveBeenCalledWith("/api/runtime/retry", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
  });
});
