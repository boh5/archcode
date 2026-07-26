import { Hono } from "hono";
import type { UpdateStatus } from "@archcode/protocol";
import { ServerError } from "../errors";
import {
  UpdateError,
  type UpdateService,
} from "../updater";

export type UpdateRoutesService = Pick<
  UpdateService,
  "getStatus" | "check" | "install"
>;

export interface UpdateRoutesOptions {
  updateService: UpdateRoutesService;
  restartController: { request(): void };
  prepareForRestart(): {
    ready: boolean;
    activeFamilyCount?: number;
  };
}

export function createUpdateRoutes(options: UpdateRoutesOptions): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json<UpdateStatus>(
    await options.updateService.getStatus(),
  ));

  app.post("/check", async (c) => {
    try {
      return c.json<UpdateStatus>(await options.updateService.check());
    } catch (error) {
      throw mapUpdateError(error);
    }
  });

  app.post("/install", async (c) => {
    try {
      return c.json<UpdateStatus>(await options.updateService.install());
    } catch (error) {
      throw mapUpdateError(error);
    }
  });

  app.post("/restart", async (c) => {
    try {
      const status = await options.updateService.getStatus();
      if (!status.restartRequired || status.phase !== "restart_pending") {
        throw new UpdateError(
          "UPDATE_RESTART_UNAVAILABLE",
          "No installed ArchCode update is waiting for restart",
        );
      }
      if (!status.restartSupported) {
        throw new UpdateError(
          "UPDATE_RESTART_UNAVAILABLE",
          "This ArchCode process was not started by the update launcher",
        );
      }
      const admission = options.prepareForRestart();
      if (!admission.ready) {
        throw new ServerError(
          "UPDATE_RUNTIME_BUSY",
          "ArchCode will restart only after every running Session becomes idle",
          409,
          { activeFamilyCount: admission.activeFamilyCount ?? 1 },
        );
      }
      options.restartController.request();
      return c.json<UpdateStatus>(status, 202);
    } catch (error) {
      throw mapUpdateError(error);
    }
  });

  return app;
}

function mapUpdateError(error: unknown): Error {
  if (!(error instanceof UpdateError)) {
    return error instanceof Error ? error : new Error("Update operation failed");
  }
  const status = error.code === "UPDATE_BUSY"
    || error.code === "UPDATE_NOT_AVAILABLE"
    || error.code === "UPDATE_RUNTIME_BUSY"
    ? 409
    : error.code === "UPDATE_UNMANAGED_INSTALL"
      || error.code === "UPDATE_RECEIPT_MISMATCH"
      || error.code === "UPDATE_INCOMPATIBLE"
      || error.code === "UPDATE_RESTART_UNAVAILABLE"
        ? 422
        : error.code === "UPDATE_DOWNLOAD_FAILED"
          || error.code === "UPDATE_CHECK_FAILED"
          ? 502
          : 500;
  return new ServerError(error.code, error.message, status);
}
