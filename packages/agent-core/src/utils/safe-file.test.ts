import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite, isContained, resolveContainedPath } from "./safe-file";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "safe-file");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("atomicWrite", () => {
  test("creates parent directories and writes content", async () => {
    const filePath = join(TMP_DIR, "nested", "file.txt");

    await atomicWrite(filePath, "hello");

    expect(await Bun.file(filePath).text()).toBe("hello");
  });

  test("replaces existing file without leaving temp files", async () => {
    const filePath = join(TMP_DIR, "state.json");

    await atomicWrite(filePath, "first");
    await atomicWrite(filePath, "second");

    expect(await Bun.file(filePath).text()).toBe("second");
    const entries = await readdir(TMP_DIR);
    expect(entries.some((entry) => entry.startsWith(".tmp-"))).toBe(false);
  });
});

describe("path containment helpers", () => {
  test("detects contained paths using resolve plus startsWith", () => {
    expect(isContained(join(TMP_DIR, "child"), TMP_DIR)).toBe(true);
    expect(isContained(TMP_DIR, TMP_DIR)).toBe(true);
    expect(isContained(resolve(TMP_DIR, "..", "escape"), TMP_DIR)).toBe(false);
  });

  test("resolves contained relative paths", async () => {
    await expect(resolveContainedPath("child/file.txt", TMP_DIR)).resolves.toBe(
      resolve(TMP_DIR, "child", "file.txt"),
    );
  });

  test("rejects absolute paths and traversal paths", async () => {
    await expect(resolveContainedPath("/etc/passwd", TMP_DIR)).rejects.toThrow(
      "Absolute paths are not allowed",
    );
    await expect(resolveContainedPath("../escape", TMP_DIR)).rejects.toThrow(
      "Path escapes the allowed root directory",
    );
  });
});
