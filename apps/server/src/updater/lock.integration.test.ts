import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_LOCK_FILE_NAME } from "./constants";
import { acquireUpdateLock } from "./lock";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("update advisory lock", () => {
  test("reuses a crash-left file without deleting a live successor lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "archcode-update-lock-"));
    roots.push(root);
    const directory = join(root, "bin");
    await mkdir(directory);
    const executablePath = join(directory, "archcode");
    await writeFile(executablePath, "binary");
    const aliasDirectory = join(root, "alias");
    await symlink(directory, aliasDirectory);
    await writeFile(join(directory, UPDATE_LOCK_FILE_NAME), JSON.stringify({
      schemaVersion: 1,
      pid: 999_999,
      token: "stale",
      startedAt: 1,
    }));

    const first = await acquireUpdateLock(executablePath);
    await expect(acquireUpdateLock(join(aliasDirectory, "archcode"))).rejects.toMatchObject({
      code: "UPDATE_BUSY",
    });
    first.assertOwned();
    await first.release();

    const successor = await acquireUpdateLock(executablePath);
    successor.assertOwned();
    await successor.release();
  });
});
