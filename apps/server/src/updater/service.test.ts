import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { silentLogger } from "@archcode/agent-core";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
} from "./constants";
import { UpdateError } from "./errors";
import {
  createInstallReceipt,
  installReceiptPath,
  writeInstallReceipt,
} from "./receipt";
import type { ReleaseClientPort, VerifiedRelease } from "./release-client";
import {
  UpdateService,
  type UpdateTimer,
  type UpdateTimerHandle,
} from "./service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("UpdateService", () => {
  test("delays the next automatic check for a full interval after a failed attempt", async () => {
    const homeDir = await createTemporaryDirectory();
    const scheduled: Array<{ delayMs: number; handle: UpdateTimerHandle }> = [];
    const cancelled: UpdateTimerHandle[] = [];
    const timer: UpdateTimer = {
      schedule(_callback, delayMs) {
        const handle = {};
        scheduled.push({ delayMs, handle });
        return handle;
      },
      cancel(handle) {
        cancelled.push(handle);
      },
    };
    const releaseClient: ReleaseClientPort = {
      fetchLatest: async () => {
        throw new UpdateError(
          "UPDATE_DOWNLOAD_FAILED",
          "The release service is unavailable",
        );
      },
      downloadArchive: async () => {
        throw new Error("unexpected archive download");
      },
    };
    const service = new UpdateService({
      currentVersion: "1.0.0",
      executablePath: process.execPath,
      restartSupported: false,
      autoCheckEnabled: true,
      homeDir,
      now: () => 10_000,
      timer,
      releaseClient,
      logger: silentLogger,
    });

    await service.start();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([
      UPDATE_STARTUP_DELAY_MS,
    ]);

    await expect(service.check()).rejects.toMatchObject({
      code: "UPDATE_DOWNLOAD_FAILED",
    });

    expect(cancelled).toEqual([scheduled[0]!.handle]);
    expect(scheduled.at(-1)?.delayMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await service.stop();
  });

  test("refuses to install a newer release into an unmanaged executable", async () => {
    const homeDir = await createTemporaryDirectory();
    const release = releaseFixture("1.1.0");
    let archiveDownloads = 0;
    const service = new UpdateService({
      currentVersion: "1.0.0",
      executablePath: process.execPath,
      restartSupported: false,
      autoCheckEnabled: false,
      homeDir,
      releaseClient: {
        fetchLatest: async () => release,
        downloadArchive: async () => {
          archiveDownloads += 1;
        },
      },
      logger: silentLogger,
    });

    await expect(service.install()).rejects.toMatchObject({
      code: "UPDATE_UNMANAGED_INSTALL",
    });
    expect(archiveDownloads).toBe(0);
    expect((await service.getStatus()).phase).toBe("error");
    await service.stop();
  });

  test("requires restart before the running updater can install again", async () => {
    const root = await createTemporaryDirectory();
    const executablePath = join(root, "archcode");
    await Bun.write(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    await writeInstallReceipt(
      installReceiptPath(executablePath),
      await createInstallReceipt({
        binaryPath: executablePath,
        installPath: executablePath,
        version: "1.1.0",
      }),
    );
    let checks = 0;
    const service = new UpdateService({
      currentVersion: "1.0.0",
      executablePath,
      restartSupported: true,
      autoCheckEnabled: false,
      homeDir: root,
      releaseClient: {
        fetchLatest: async () => {
          checks += 1;
          return releaseFixture("2.0.0");
        },
        downloadArchive: async () => undefined,
      },
      logger: silentLogger,
    });

    await expect(service.install()).rejects.toMatchObject({
      code: "UPDATE_RESTART_UNAVAILABLE",
    });
    expect(checks).toBe(0);
    await service.stop();
  });

  test("stop waits for an entered update operation", async () => {
    const homeDir = await createTemporaryDirectory();
    let releaseCheck!: () => void;
    const checkReleased = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let checkEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      checkEntered = resolve;
    });
    const service = new UpdateService({
      currentVersion: "1.0.0",
      executablePath: process.execPath,
      restartSupported: false,
      autoCheckEnabled: false,
      homeDir,
      releaseClient: {
        fetchLatest: async () => {
          checkEntered();
          await checkReleased;
          return releaseFixture("1.1.0");
        },
        downloadArchive: async () => undefined,
      },
      logger: silentLogger,
    });

    const checking = service.check();
    await entered;
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseCheck();
    await checking;
    await stopping;
    expect(stopped).toBe(true);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archcode-update-service-"));
  temporaryDirectories.push(directory);
  return directory;
}

function releaseFixture(version: string): VerifiedRelease {
  return {
    releaseUrl: `https://github.com/boh5/archcode/releases/tag/v${version}`,
    manifest: {
      schemaVersion: 3,
      name: "archcode",
      version,
      tag: `v${version}`,
      minimumDirectUpdateFrom: "1.0.0",
      assets: [
        {
          name: "install.sh",
          kind: "installer",
          size: 1,
          sha256: "1".repeat(64),
        },
        {
          name: "archcode-test.tar.gz",
          kind: "archive",
          platform: process.platform === "darwin" ? "macOS" : "Linux",
          architecture: process.arch === "arm64" ? "arm64" : "x64",
          archiveFormat: "tar.gz",
          size: 1,
          sha256: "2".repeat(64),
          binary: {
            name: "archcode",
            size: 1,
            sha256: "3".repeat(64),
          },
        },
      ],
    },
  };
}
