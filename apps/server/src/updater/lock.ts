import {
  chmod,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { UPDATE_LOCK_FILE_NAME } from "./constants";
import { UpdateError } from "./errors";
import { syncDirectory } from "./atomic-file";

export interface UpdateLock {
  assertOwned(): void;
  release(): Promise<void>;
}

/**
 * Holds a kernel advisory lock in a tiny helper process. The kernel releases
 * the lock when either process dies, so a crash leaves only an unlocked
 * informational file and never requires unsafe stale-file deletion.
 */
export async function acquireUpdateLock(
  executablePath: string,
): Promise<UpdateLock> {
  let normalizedExecutablePath: string;
  try {
    normalizedExecutablePath = await realpath(executablePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    normalizedExecutablePath = join(
      await realpath(dirname(resolve(executablePath))),
      basename(executablePath),
    );
  }
  const directory = dirname(normalizedExecutablePath);
  const path = join(directory, UPDATE_LOCK_FILE_NAME);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const seed = await open(path, "a", 0o600);
  await seed.close();
  await chmod(path, 0o600);

  const command = advisoryLockCommand(path);
  let child: ReturnType<typeof spawnAdvisoryLockHelper>;
  try {
    child = spawnAdvisoryLockHelper(command);
  } catch (error) {
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "ArchCode could not start the operating-system update lock helper",
      { cause: error },
    );
  }

  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (
    first.done
    || first.value.byteLength !== 1
    || first.value[0] !== "1".charCodeAt(0)
  ) {
    await child.exited;
    throw new UpdateError(
      "UPDATE_BUSY",
      "Another ArchCode update is already running",
    );
  }

  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  try {
    const file = await open(path, "r+");
    try {
      await file.truncate(0);
      await file.writeFile(`${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        token: randomUUID(),
        startedAt: Date.now(),
      })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(directory);
  } catch (error) {
    child.stdin.end();
    await child.exited;
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "ArchCode could not persist update lock ownership",
      { cause: error },
    );
  }

  let released = false;
  return {
    assertOwned(): void {
      if (released || exited) {
        throw new UpdateError(
          "UPDATE_BUSY",
          "ArchCode lost the operating-system update lock",
        );
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      child.stdin.end();
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new UpdateError(
          "UPDATE_INSTALL_FAILED",
          "ArchCode could not release the operating-system update lock cleanly",
        );
      }
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function spawnAdvisoryLockHelper(command: string[]) {
  return Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
}

function advisoryLockCommand(path: string): string[] {
  const holdCommand = "printf 1; cat >/dev/null";
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/lockf")) {
      throw new UpdateError(
        "UPDATE_INSTALL_FAILED",
        "Direct update requires /usr/bin/lockf on macOS",
      );
    }
    return [
      "/usr/bin/lockf",
      "-t",
      "0",
      path,
      "/bin/sh",
      "-c",
      holdCommand,
    ];
  }
  if (process.platform === "linux") {
    const flock = ["/usr/bin/flock", "/bin/flock"].find(existsSync);
    if (flock === undefined) {
      throw new UpdateError(
        "UPDATE_INSTALL_FAILED",
        "Direct update requires the util-linux flock command on Linux",
      );
    }
    return [
      flock,
      "-n",
      path,
      "/bin/sh",
      "-c",
      holdCommand,
    ];
  }
  throw new UpdateError(
    "UPDATE_UNSUPPORTED_PLATFORM",
    `Direct updates are not available on ${process.platform}`,
  );
}
