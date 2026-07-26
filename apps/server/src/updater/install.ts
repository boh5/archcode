import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gt, gte } from "semver";
import { UpdateError } from "./errors";
import { sha256File } from "./hash";
import { acquireUpdateLock } from "./lock";
import {
  selectReleaseArchive,
} from "./platform";
import {
  createInstallReceipt,
  requireManagedInstall,
  type InstallReceipt,
} from "./receipt";
import type {
  ReleaseClientPort,
  VerifiedRelease,
} from "./release-client";
import {
  recoverInterruptedInstall,
  replaceManagedInstall,
} from "./transaction";

export interface InstallUpdateOptions {
  currentVersion: string;
  executablePath: string;
  release: VerifiedRelease;
  releaseClient: ReleaseClientPort;
  installedAt?: number;
  onProgress?: (
    phase: "downloading" | "verifying" | "installing",
    downloadedBytes?: number,
    totalBytes?: number,
  ) => void;
}

export async function installVerifiedRelease(
  options: InstallUpdateOptions,
): Promise<InstallReceipt> {
  const lock = await acquireUpdateLock(options.executablePath);
  let temporaryDirectory: string | undefined;
  try {
    await recoverInterruptedInstall(options.executablePath);
    const current = await requireManagedInstall(options.executablePath);
    const { manifest } = options.release;
    if (current.receipt.version !== options.currentVersion) {
      throw new UpdateError(
        "UPDATE_RESTART_UNAVAILABLE",
        `Restart ArchCode v${current.receipt.version} before installing another update`,
      );
    }
    if (!gte(options.currentVersion, manifest.minimumDirectUpdateFrom)) {
      throw new UpdateError(
        "UPDATE_INCOMPATIBLE",
        `ArchCode v${options.currentVersion} cannot update directly to v${manifest.version}; reinstall the latest release`,
      );
    }
    if (!gt(manifest.version, current.receipt.version)) {
      throw new UpdateError(
        "UPDATE_NOT_AVAILABLE",
        `ArchCode v${current.receipt.version} is already current`,
      );
    }

    const asset = selectReleaseArchive(manifest);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "archcode-update-"));
    const archivePath = join(temporaryDirectory, asset.name);
    options.onProgress?.("downloading", 0, asset.size);
    await options.releaseClient.downloadArchive({
      manifest,
      asset,
      destinationPath: archivePath,
      onProgress: (downloadedBytes, totalBytes) => {
        options.onProgress?.(
          "downloading",
          downloadedBytes,
          totalBytes,
        );
      },
    });

    options.onProgress?.("verifying");
    if (await sha256File(archivePath) !== asset.sha256) {
      throw new UpdateError(
        "UPDATE_ARCHIVE_INVALID",
        `Release archive ${asset.name} does not match its signed digest`,
      );
    }
    const extractedBinary = await extractAndVerifyArchive({
      archivePath,
      expectedBinarySha256: asset.binary.sha256,
      expectedBinarySize: asset.binary.size,
      expectedVersion: manifest.version,
      destinationDirectory: temporaryDirectory,
    });
    const receipt = await createInstallReceipt({
      binaryPath: extractedBinary,
      installPath: current.executablePath,
      version: manifest.version,
      installedAt: options.installedAt,
    });

    options.onProgress?.("installing");
    lock.assertOwned();
    await replaceManagedInstall({
      current,
      stagedBinaryPath: extractedBinary,
      receipt,
    });
    return receipt;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "ArchCode could not install the verified update",
      { cause: error },
    );
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    await lock.release();
  }
}

async function extractAndVerifyArchive(input: {
  archivePath: string;
  destinationDirectory: string;
  expectedBinarySha256: string;
  expectedBinarySize: number;
  expectedVersion: string;
}): Promise<string> {
  const entries = (await runProcess(["tar", "-tzf", input.archivePath])).trim();
  if (entries !== "archcode") {
    throw new UpdateError(
      "UPDATE_ARCHIVE_INVALID",
      "The release archive must contain exactly one entry named archcode",
    );
  }
  const listing = await runProcess(["tar", "-tvzf", input.archivePath]);
  if (!listing.startsWith("-")) {
    throw new UpdateError(
      "UPDATE_ARCHIVE_INVALID",
      "The release archive entry must be a regular file",
    );
  }
  const extractDirectory = join(input.destinationDirectory, "extracted");
  await mkdir(extractDirectory, { mode: 0o700 });
  const binaryPath = join(extractDirectory, "archcode");
  await streamArchiveBinary({
    archivePath: input.archivePath,
    destinationPath: binaryPath,
    expectedSize: input.expectedBinarySize,
  });
  if (await sha256File(binaryPath) !== input.expectedBinarySha256) {
    throw new UpdateError(
      "UPDATE_ARCHIVE_INVALID",
      "The extracted ArchCode executable does not match its signed digest",
    );
  }
  await chmod(binaryPath, 0o755);
  const reportedVersion = (await runProcess([binaryPath, "--version"])).trim();
  if (reportedVersion !== `archcode ${input.expectedVersion}`) {
    throw new UpdateError(
      "UPDATE_ARCHIVE_INVALID",
      `The downloaded executable reported an unexpected version: ${reportedVersion}`,
    );
  }
  return binaryPath;
}

async function streamArchiveBinary(input: {
  archivePath: string;
  destinationPath: string;
  expectedSize: number;
}): Promise<void> {
  const file = await open(input.destinationPath, "wx", 0o600);
  try {
    const child = Bun.spawn([
      "tar",
      "-xOzf",
      input.archivePath,
      "archcode",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let extractedBytes = 0;
    let failure: unknown;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        extractedBytes += chunk.value.byteLength;
        if (extractedBytes > input.expectedSize) {
          failure = new UpdateError(
            "UPDATE_ARCHIVE_INVALID",
            "The extracted ArchCode executable exceeds its signed size",
          );
          child.kill();
          break;
        }
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const result = await file.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset,
          );
          offset += result.bytesWritten;
        }
      }
      await file.sync();
    } catch (error) {
      failure = error;
      child.kill();
    } finally {
      reader.releaseLock();
    }
    const [exitCode] = await Promise.all([child.exited, stderr]);
    if (failure !== undefined) throw failure;
    if (exitCode !== 0 || extractedBytes !== input.expectedSize) {
      throw new UpdateError(
        "UPDATE_ARCHIVE_INVALID",
        "The extracted ArchCode executable does not match the signed release metadata",
      );
    }
  } finally {
    await file.close();
  }
}

async function runProcess(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new UpdateError(
      "UPDATE_ARCHIVE_INVALID",
      `${command[0]} failed while verifying the release archive`,
    );
  }
  return stdout;
}
