import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { gt, valid } from "semver";
import { z } from "zod";
import type {
  UpdateProgress,
  UpdateStatus,
} from "@archcode/protocol";
import { USER_DATA_DIR_NAME } from "@archcode/protocol";
import type { Logger } from "@archcode/agent-core";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  UPDATE_STATE_FILE_NAME,
  UPDATE_TRANSACTION_FILE_NAME,
} from "./constants";
import { UpdateError } from "./errors";
import { installVerifiedRelease } from "./install";
import {
  inspectManagedInstall,
  requireManagedInstall,
} from "./receipt";
import {
  ReleaseClient,
  type ReleaseClientPort,
  type VerifiedRelease,
} from "./release-client";
import { writeJsonAtomic } from "./atomic-file";
import { acquireUpdateLock } from "./lock";
import { recoverInterruptedInstall } from "./transaction";

const MAX_UPDATE_STATE_BYTES = 64 * 1024;
const PROGRESS_PUBLISH_INTERVAL_MS = 200;

const persistedUpdateStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastCheckedAt: z.number().int().nonnegative(),
  latest: z.object({
    version: z.string().refine((value) => valid(value) === value),
    releaseUrl: z.string().url(),
  }).strict(),
}).strict();

type PersistedUpdateState = z.infer<typeof persistedUpdateStateSchema>;

export interface UpdateTimerHandle {
  unref?(): void;
}

export interface UpdateTimer {
  schedule(callback: () => void, delayMs: number): UpdateTimerHandle;
  cancel(handle: UpdateTimerHandle): void;
}

const systemUpdateTimer: UpdateTimer = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface UpdateServiceOptions {
  currentVersion: string;
  executablePath: string;
  restartSupported: boolean;
  autoCheckEnabled: boolean;
  logger: Logger;
  releaseClient?: ReleaseClientPort;
  homeDir?: string;
  now?: () => number;
  timer?: UpdateTimer;
  onStatusChange?: (status: UpdateStatus) => void;
}

export class UpdateService {
  readonly #currentVersion: string;
  readonly #executablePath: string;
  readonly #restartSupported: boolean;
  readonly #autoCheckEnabled: boolean;
  readonly #logger: Logger;
  readonly #releaseClient: ReleaseClientPort;
  readonly #statePath: string;
  readonly #now: () => number;
  readonly #timer: UpdateTimer;
  readonly #onStatusChange?: (status: UpdateStatus) => void;
  #phase: UpdateStatus["phase"] = "idle";
  #latest: UpdateStatus["latest"];
  #lastCheckedAt: number | undefined;
  #lastAttemptAt: number | undefined;
  #progress: UpdateProgress | undefined;
  #error: UpdateStatus["error"];
  #operation: Promise<UpdateStatus> | undefined;
  #started = false;
  #closed = false;
  #operationAdmissionOpen = true;
  #stopPromise: Promise<void> | undefined;
  #timerHandle: UpdateTimerHandle | undefined;
  #lastProgressPublishAt = 0;

  constructor(options: UpdateServiceOptions) {
    this.#currentVersion = options.currentVersion;
    this.#executablePath = options.executablePath;
    this.#restartSupported = options.restartSupported;
    this.#autoCheckEnabled = options.autoCheckEnabled;
    this.#logger = options.logger;
    this.#releaseClient = options.releaseClient ?? new ReleaseClient();
    this.#statePath = join(
      options.homeDir ?? homedir(),
      USER_DATA_DIR_NAME,
      UPDATE_STATE_FILE_NAME,
    );
    this.#now = options.now ?? Date.now;
    this.#timer = options.timer ?? systemUpdateTimer;
    this.#onStatusChange = options.onStatusChange;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error("UpdateService is stopped");
    this.#started = true;
    try {
      await this.#recoverInterruptedInstall();
      const persisted = await this.#readPersistedState();
      if (persisted !== undefined) {
        this.#lastCheckedAt = persisted.lastCheckedAt;
        this.#latest = persisted.latest;
      }
      await this.#publish();
      if (this.#autoCheckEnabled) this.#scheduleNextCheck();
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return await this.#stopPromise;
    this.#closed = true;
    this.#started = false;
    this.#operationAdmissionOpen = false;
    this.#cancelTimer();
    const operation = this.#operation;
    this.#stopPromise = operation === undefined
      ? Promise.resolve()
      : operation.then(() => undefined, () => undefined);
    await this.#stopPromise;
  }

  closeAdmissionIfIdle(): boolean {
    this.#operationAdmissionOpen = false;
    this.#cancelTimer();
    if (this.#operation === undefined) return true;
    this.#operationAdmissionOpen = true;
    if (this.#autoCheckEnabled && this.#started) this.#scheduleNextCheck();
    return false;
  }

  reopenAdmission(): void {
    if (this.#closed) return;
    this.#operationAdmissionOpen = true;
    if (this.#autoCheckEnabled && this.#started) this.#scheduleNextCheck();
  }

  async getStatus(): Promise<UpdateStatus> {
    if (!this.#started) await this.start();
    return await this.#projectStatus();
  }

  async check(): Promise<UpdateStatus> {
    return await this.#runExclusive("UPDATE_CHECK_FAILED", async () => {
      const release = await this.#checkLatest();
      return await this.#finishOperation(release);
    });
  }

  async install(): Promise<UpdateStatus> {
    return await this.#runExclusive("UPDATE_INSTALL_FAILED", async () => {
      const before = await requireManagedInstall(this.#executablePath);
      if (before.receipt.version !== this.#currentVersion) {
        throw new UpdateError(
          "UPDATE_RESTART_UNAVAILABLE",
          `Restart ArchCode v${before.receipt.version} before installing another update`,
        );
      }
      const release = await this.#checkLatest();
      if (!gt(release.manifest.version, before.receipt.version)) {
        return await this.#finishOperation(release);
      }

      await installVerifiedRelease({
        currentVersion: this.#currentVersion,
        executablePath: this.#executablePath,
        release,
        releaseClient: this.#releaseClient,
        installedAt: this.#now(),
        onProgress: (phase, downloadedBytes, totalBytes) => {
          this.#phase = phase;
          this.#progress = {
            phase,
            ...(downloadedBytes === undefined ? {} : { downloadedBytes }),
            ...(totalBytes === undefined ? {} : { totalBytes }),
          };
          this.#publishProgress();
        },
      });
      return await this.#finishOperation(release);
    });
  }

  async #runExclusive(
    unexpectedErrorCode: "UPDATE_CHECK_FAILED" | "UPDATE_INSTALL_FAILED",
    operation: () => Promise<UpdateStatus>,
  ): Promise<UpdateStatus> {
    if (!this.#operationAdmissionOpen || this.#closed) {
      throw new UpdateError(
        "UPDATE_BUSY",
        "ArchCode update operations are closed for shutdown",
      );
    }
    if (!this.#started) await this.start();
    if (!this.#operationAdmissionOpen || this.#closed) {
      throw new UpdateError(
        "UPDATE_BUSY",
        "ArchCode update operations are closed for shutdown",
      );
    }
    if (this.#operation !== undefined) {
      throw new UpdateError("UPDATE_BUSY", "An ArchCode update operation is already running");
    }
    this.#error = undefined;
    const running = operation().catch(async (error) => {
      const updateError = error instanceof UpdateError
        ? error
        : new UpdateError(
          unexpectedErrorCode,
          "The ArchCode update operation failed",
          { cause: error },
        );
      this.#phase = "error";
      this.#progress = undefined;
      this.#error = {
        code: updateError.code,
        message: updateError.message,
      };
      await this.#publish();
      throw updateError;
    }).finally(() => {
      this.#operation = undefined;
      if (this.#autoCheckEnabled && this.#started) this.#scheduleNextCheck();
    });
    this.#operation = running;
    return await running;
  }

  async #checkLatest(): Promise<VerifiedRelease> {
    this.#lastAttemptAt = this.#now();
    this.#phase = "checking";
    this.#progress = undefined;
    await this.#publish();
    const release = await this.#releaseClient.fetchLatest();
    this.#latest = {
      version: release.manifest.version,
      releaseUrl: release.releaseUrl,
    };
    this.#lastCheckedAt = this.#now();
    try {
      await writeJsonAtomic(this.#statePath, {
        schemaVersion: 1,
        lastCheckedAt: this.#lastCheckedAt,
        latest: this.#latest,
      } satisfies PersistedUpdateState);
    } catch {
      this.#logger.warn("update.state.write_failed", {
        meta: { errorCode: "UPDATE_STATE_WRITE_FAILED" },
      });
    }
    return release;
  }

  async #finishOperation(release: VerifiedRelease): Promise<UpdateStatus> {
    this.#latest = {
      version: release.manifest.version,
      releaseUrl: release.releaseUrl,
    };
    this.#progress = undefined;
    this.#error = undefined;
    const projected = await this.#projectStatus();
    this.#phase = projected.restartRequired ? "restart_pending" : "idle";
    await this.#publish();
    return await this.#projectStatus();
  }

  #publishProgress(): void {
    const now = this.#now();
    const completed = this.#progress?.downloadedBytes !== undefined
      && this.#progress.totalBytes !== undefined
      && this.#progress.downloadedBytes === this.#progress.totalBytes;
    if (!completed && now - this.#lastProgressPublishAt < PROGRESS_PUBLISH_INTERVAL_MS) return;
    this.#lastProgressPublishAt = now;
    void this.#publish();
  }

  async #publish(): Promise<void> {
    this.#onStatusChange?.(await this.#projectStatus());
  }

  async #projectStatus(): Promise<UpdateStatus> {
    const inspection = await inspectManagedInstall(this.#executablePath);
    const installedVersion = inspection.managed
      ? inspection.receipt.version
      : this.#currentVersion;
    const latestVersion = this.#latest?.version;
    const restartRequired = inspection.managed
      && inspection.receipt.version !== this.#currentVersion;
    const updateAvailable = latestVersion !== undefined
      && valid(installedVersion) === installedVersion
      && gt(latestVersion, installedVersion);
    return {
      currentVersion: this.#currentVersion,
      phase: this.#phase,
      managed: inspection.managed,
      restartSupported: this.#restartSupported,
      updateAvailable,
      restartRequired,
      ...(this.#latest === undefined ? {} : { latest: this.#latest }),
      ...(this.#lastCheckedAt === undefined ? {} : {
        lastCheckedAt: this.#lastCheckedAt,
      }),
      ...(this.#progress === undefined ? {} : { progress: this.#progress }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  #scheduleNextCheck(): void {
    if (this.#timerHandle !== undefined) this.#timer.cancel(this.#timerHandle);
    const lastScheduledCheckAt = Math.max(
      this.#lastCheckedAt ?? 0,
      this.#lastAttemptAt ?? 0,
    ) || undefined;
    const elapsed = lastScheduledCheckAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.#now() - lastScheduledCheckAt);
    const delay = elapsed >= UPDATE_CHECK_INTERVAL_MS
      ? UPDATE_STARTUP_DELAY_MS
      : UPDATE_CHECK_INTERVAL_MS - elapsed;
    this.#timerHandle = this.#timer.schedule(() => {
      this.#timerHandle = undefined;
      void this.check().catch((error) => {
        this.#logger.warn("update.automatic_check.failed", {
          error,
          meta: {
            errorCode: error instanceof UpdateError
              ? error.code
              : "UPDATE_CHECK_FAILED",
          },
        });
      });
    }, delay);
    this.#timerHandle.unref?.();
  }

  #cancelTimer(): void {
    if (this.#timerHandle === undefined) return;
    this.#timer.cancel(this.#timerHandle);
    this.#timerHandle = undefined;
  }

  async #recoverInterruptedInstall(): Promise<void> {
    const executablePath = await realpath(this.#executablePath);
    try {
      await stat(join(dirname(executablePath), UPDATE_TRANSACTION_FILE_NAME));
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    const lock = await acquireUpdateLock(executablePath);
    try {
      await recoverInterruptedInstall(executablePath);
    } finally {
      await lock.release();
    }
  }

  async #readPersistedState(): Promise<PersistedUpdateState | undefined> {
    try {
      const info = await stat(this.#statePath);
      if (!info.isFile() || info.size > MAX_UPDATE_STATE_BYTES) return undefined;
      const parsed = persistedUpdateStateSchema.safeParse(
        JSON.parse(await readFile(this.#statePath, "utf8")) as unknown,
      );
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) return undefined;
      this.#logger.warn("update.state.read_failed", {
        meta: { errorCode: "UPDATE_STATE_READ_FAILED" },
      });
      return undefined;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
