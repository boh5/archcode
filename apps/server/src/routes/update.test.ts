import { describe, expect, mock, test } from "bun:test";
import type { UpdateStatus } from "@archcode/protocol";
import { errorHandler } from "../error-handler";
import { UpdateError } from "../updater";
import { createUpdateRoutes } from "./update";

const restartPending: UpdateStatus = {
  currentVersion: "1.2.3",
  phase: "restart_pending",
  managed: true,
  restartSupported: true,
  updateAvailable: false,
  restartRequired: true,
  latest: {
    version: "1.2.4",
    releaseUrl: "https://github.com/boh5/archcode/releases/tag/v1.2.4",
  },
};

describe("update routes", () => {
  test("accepts restart only after Runtime admission closes while idle", async () => {
    const requestRestart = mock(() => undefined);
    const prepareForRestart = mock(() => ({ ready: true }));
    const app = createUpdateRoutes({
      updateService: {
        getStatus: async () => restartPending,
        check: async () => restartPending,
        install: async () => restartPending,
      },
      restartController: { request: requestRestart },
      prepareForRestart,
    });
    app.onError(errorHandler);

    const response = await app.request("/restart", { method: "POST" });

    expect(response.status).toBe(202);
    expect(prepareForRestart).toHaveBeenCalledTimes(1);
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  test("keeps restart closed and reports active Runtime work", async () => {
    const requestRestart = mock(() => undefined);
    const app = createUpdateRoutes({
      updateService: {
        getStatus: async () => restartPending,
        check: async () => restartPending,
        install: async () => restartPending,
      },
      restartController: { request: requestRestart },
      prepareForRestart: () => ({
          ready: false,
          activeFamilyCount: 2,
        }),
    });
    app.onError(errorHandler);

    const response = await app.request("/restart", { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "UPDATE_RUNTIME_BUSY",
        message: "ArchCode will restart only after every running Session becomes idle",
        details: { activeFamilyCount: 2 },
      },
    });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  test("maps unmanaged installation failures to an actionable client error", async () => {
    const app = createUpdateRoutes({
      updateService: {
        getStatus: async () => restartPending,
        check: async () => restartPending,
        install: async () => {
          throw new UpdateError(
            "UPDATE_UNMANAGED_INSTALL",
            "Install with the official installer",
          );
        },
      },
      restartController: { request: () => undefined },
      prepareForRestart: () => ({ ready: true }),
    });
    app.onError(errorHandler);

    const response = await app.request("/install", { method: "POST" });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "UPDATE_UNMANAGED_INSTALL",
      },
    });
  });
});
