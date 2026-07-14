import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { silentLogger } from "../logger";
import {
  DEFAULT_QUOTA_MB,
  enforceQuota,
  getCacheStats,
} from "./tool-output-cache";

const BASE_TMP_DIR = join(import.meta.dir, "__test_tmp__", "tool-output-cache", crypto.randomUUID());
let TMP_DIR: string;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeFile(dir: string, name: string, sizeBytes: number): Promise<string> {
  const filePath = join(dir, name);
  await Bun.write(filePath, Buffer.alloc(sizeBytes, 0));
  return filePath;
}

async function writeFileWithMtime(
  dir: string,
  name: string,
  sizeBytes: number,
  mtime: Date,
): Promise<string> {
  const filePath = await writeFile(dir, name, sizeBytes);
  const mtimeSec = mtime.getTime() / 1000;
  try {
    const { utimes } = await import("node:fs/promises");
    await utimes(filePath, mtimeSec, mtimeSec);
  } catch {
    // utimes not supported on this platform
  }
  return filePath;
}

afterAll(() => rm(BASE_TMP_DIR, { recursive: true, force: true }));

beforeEach(async () => {
  TMP_DIR = join(BASE_TMP_DIR, randomUUID());
  await mkdir(TMP_DIR, { recursive: true });
});

describe("getCacheStats", () => {
  it("returns zeros for empty directory", async () => {
    const stats = await getCacheStats(TMP_DIR, { logger: silentLogger });
    expect(stats.totalSizeBytes).toBe(0);
    expect(stats.fileCount).toBe(0);
    expect(stats.oldestFile).toBeNull();
  });

  it("returns stats for a directory with files", async () => {
    await writeFile(TMP_DIR, "a.txt", 100);
    await writeFile(TMP_DIR, "b.txt", 200);

    const stats = await getCacheStats(TMP_DIR, { logger: silentLogger });
    expect(stats.totalSizeBytes).toBe(300);
    expect(stats.fileCount).toBe(2);
    expect(stats.oldestFile).not.toBeNull();
  });

  it("correctly identifies the oldest file", async () => {
    const now = Date.now();
    const day = 86400000;

    await writeFileWithMtime(TMP_DIR, "old.txt", 100, new Date(now - 3 * day));
    await delay(10);
    await writeFileWithMtime(TMP_DIR, "mid.txt", 200, new Date(now - 2 * day));
    await delay(10);
    await writeFileWithMtime(TMP_DIR, "new.txt", 300, new Date(now - day));

    const stats = await getCacheStats(TMP_DIR, { logger: silentLogger });
    expect(stats.totalSizeBytes).toBe(600);
    expect(stats.fileCount).toBe(3);
    expect(stats.oldestFile).not.toBeNull();
    expect(stats.oldestFile!.path).toContain("old.txt");
    expect(stats.oldestFile!.size).toBe(100);
  });

  it("handles non-existent directory gracefully", async () => {
    const nonExistent = join(TMP_DIR, "does-not-exist");
    const stats = await getCacheStats(nonExistent, { logger: silentLogger });

    expect(stats.totalSizeBytes).toBe(0);
    expect(stats.fileCount).toBe(0);
    expect(stats.oldestFile).toBeNull();
  });

  it("returns stats for files in nested subdirectories", async () => {
    await mkdir(join(TMP_DIR, "sub1"), { recursive: true });
    await mkdir(join(TMP_DIR, "sub2"), { recursive: true });

    await writeFile(TMP_DIR, "root.txt", 50);
    await writeFile(join(TMP_DIR, "sub1"), "a.txt", 100);
    await writeFile(join(TMP_DIR, "sub2"), "b.txt", 150);

    const stats = await getCacheStats(TMP_DIR, { logger: silentLogger });
    expect(stats.totalSizeBytes).toBe(300);
    expect(stats.fileCount).toBe(3);
  });
});

describe("enforceQuota", () => {
  it("returns 0 when under quota", async () => {
    await writeFile(TMP_DIR, "a.txt", 100);
    await writeFile(TMP_DIR, "b.txt", 200);

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 1 });
    expect(deleted).toBe(0);
  });

  it("returns 0 at exact quota boundary", async () => {
    await writeFile(TMP_DIR, "a.txt", 300);

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 300 / (1024 * 1024) });
    expect(deleted).toBe(0);
  });

  it("deletes oldest files when over quota", async () => {
    const now = Date.now();
    const day = 86400000;

    await writeFileWithMtime(TMP_DIR, "old.txt", 300, new Date(now - 3 * day));
    await delay(5);
    await writeFileWithMtime(TMP_DIR, "mid.txt", 250, new Date(now - 2 * day));
    await delay(5);
    await writeFileWithMtime(TMP_DIR, "new.txt", 10, new Date(now - day));

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 500 / (1024 * 1024) });
    expect(deleted).toBe(1);

    const oldExists = await Bun.file(join(TMP_DIR, "old.txt")).exists();
    const midExists = await Bun.file(join(TMP_DIR, "mid.txt")).exists();
    const newExists = await Bun.file(join(TMP_DIR, "new.txt")).exists();

    expect(oldExists).toBe(false);
    expect(midExists).toBe(true);
    expect(newExists).toBe(true);

    const remainingStats = await getCacheStats(TMP_DIR, { logger: silentLogger });
    expect(remainingStats.totalSizeBytes).toBe(260);
  });

  it("deletes multiple oldest files until under quota", async () => {
    const now = Date.now();
    const day = 86400000;

    await writeFileWithMtime(TMP_DIR, "oldest.txt", 300, new Date(now - 3 * day));
    await delay(5);
    await writeFileWithMtime(TMP_DIR, "middle.txt", 250, new Date(now - 2 * day));
    await delay(5);
    await writeFileWithMtime(TMP_DIR, "newest.txt", 10, new Date(now - day));

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 100 / (1024 * 1024) });
    expect(deleted).toBe(2);

    const oldestExists = await Bun.file(join(TMP_DIR, "oldest.txt")).exists();
    const middleExists = await Bun.file(join(TMP_DIR, "middle.txt")).exists();
    const newestExists = await Bun.file(join(TMP_DIR, "newest.txt")).exists();

    expect(oldestExists).toBe(false);
    expect(middleExists).toBe(false);
    expect(newestExists).toBe(true);

    const remainingStats = await getCacheStats(TMP_DIR, { logger: silentLogger });
    expect(remainingStats.totalSizeBytes).toBe(10);
  });

  it("handles concurrent deletion gracefully", async () => {
    await writeFile(TMP_DIR, "a.txt", 200);
    await writeFile(TMP_DIR, "b.txt", 200);
    await writeFile(TMP_DIR, "c.txt", 200);

    await Bun.file(join(TMP_DIR, "a.txt")).delete();

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 200 / (1024 * 1024) });

    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it("handles empty directory gracefully", async () => {
    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger });
    expect(deleted).toBe(0);
  });

  it("deletes nothing when single file fits within quota", async () => {
    await writeFile(TMP_DIR, "big.txt", 100);

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 1 });
    expect(deleted).toBe(0);
  });

  it("deletes single oversized file", async () => {
    await writeFile(TMP_DIR, "huge.txt", 1024 * 1024 * 2);

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 1 });
    expect(deleted).toBe(1);

    const exists = await Bun.file(join(TMP_DIR, "huge.txt")).exists();
    expect(exists).toBe(false);
  });

  it("uses DEFAULT_QUOTA_MB when called without quota", async () => {
    expect(DEFAULT_QUOTA_MB).toBe(500);
    await writeFile(TMP_DIR, "a.txt", 100);
    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger });
    expect(deleted).toBe(0);
  });

  it("deletes files across subdirectories", async () => {
    await mkdir(join(TMP_DIR, "session1"), { recursive: true });
    await mkdir(join(TMP_DIR, "session2"), { recursive: true });

    const now = Date.now();
    const day = 86400000;

    await writeFileWithMtime(join(TMP_DIR, "session1"), "old.txt", 300, new Date(now - 3 * day));
    await delay(5);
    await writeFileWithMtime(join(TMP_DIR, "session2"), "new.txt", 200, new Date(now - day));

    const deleted = await enforceQuota(TMP_DIR, { logger: silentLogger, quotaMB: 400 / (1024 * 1024) });
    expect(deleted).toBe(1);

    const oldExists = await Bun.file(join(TMP_DIR, "session1", "old.txt")).exists();
    const newExists = await Bun.file(join(TMP_DIR, "session2", "new.txt")).exists();
    expect(oldExists).toBe(false);
    expect(newExists).toBe(true);
  });
});
