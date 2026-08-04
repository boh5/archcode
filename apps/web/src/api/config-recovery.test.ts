import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getConfigRecoveryStatus,
  removeInvalidConfigItems,
  resetInvalidConfig,
  retryConfigRecovery,
} from "./config-recovery";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Config Recovery API", () => {
  test("keeps the process-local grant in Authorization for every recovery action", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/config-recovery") return Response.json({
        configPath: "/home/test/.archcode/config.json",
        issues: [],
        removableItems: [],
      });
      return Response.json({ status: { mode: "setup" } });
    }) as unknown as typeof fetch;

    await getConfigRecoveryStatus("grant-token");
    await retryConfigRecovery("grant-token");
    await removeInvalidConfigItems("grant-token", "revision-sentinel-1234", ["abcdefghijklmnopqrstuv"]);
    await resetInvalidConfig("grant-token");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/config-recovery", expect.objectContaining({
      headers: expect.any(Headers),
      credentials: "same-origin",
    }));
    for (const call of (fetch as unknown as ReturnType<typeof mock>).mock.calls) {
      expect((call[1] as RequestInit).headers).toBeInstanceOf(Headers);
      expect(((call[1] as RequestInit).headers as Headers).get("Authorization")).toBe("Bearer grant-token");
    }
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/config-recovery/retry", expect.objectContaining({
      method: "POST",
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/config-recovery/remove-items", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        expectedRevision: "revision-sentinel-1234",
        itemIds: ["abcdefghijklmnopqrstuv"],
        confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS",
      }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, "/api/config-recovery/reset", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ confirmation: "DELETE_INVALID_CONFIG" }),
    }));
  });
});
