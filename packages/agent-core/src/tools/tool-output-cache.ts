import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger";

export const DEFAULT_QUOTA_MB = 500;

export interface CacheStats {
  totalSizeBytes: number;
  fileCount: number;
  oldestFile: { path: string; mtime: Date; size: number } | null;
}

export interface CacheStatsOptions {
  logger: Logger;
}

export interface EnforceQuotaOptions {
  logger: Logger;
  quotaMB?: number;
}

interface FileEntry {
  path: string;
  size: number;
  mtime: Date;
}

async function collectFiles(
  dir: string,
  options: { logger: Logger; quotaEnforcement: boolean },
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  let dirEntries;
  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const level = options.quotaEnforcement ? "warn" : "debug";
    options.logger[level]("tool.output.cache.scan.failed", {
      error,
      meta: { directory: dir },
    });
    return entries;
  }

  for (const entry of dirEntries) {
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const subEntries = await collectFiles(fullPath, options);
        entries.push(...subEntries);
      } else if (entry.isFile()) {
        const bunFile = Bun.file(fullPath);
        const size = bunFile.size;
        const mtimeMs = bunFile.lastModified;
        const mtime = new Date(mtimeMs > 0 ? mtimeMs : Date.now());
        entries.push({ path: fullPath, size, mtime });
      }
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && ((e as { code: string }).code === "ENOENT" || (e as { code: string }).code === "EACCES")) {
        continue;
      }
      options.logger.debug("tool.output.cache.file.skipped", {
        error: e,
        meta: { path: fullPath },
      });
      continue;
    }
  }

  return entries;
}

export async function getCacheStats(dir: string, options: CacheStatsOptions): Promise<CacheStats> {
  const files = await collectFiles(dir, { logger: options.logger, quotaEnforcement: false });

  if (files.length === 0) {
    return { totalSizeBytes: 0, fileCount: 0, oldestFile: null };
  }

  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const oldestFile = files.reduce((oldest, current) =>
    current.mtime.getTime() < oldest.mtime.getTime() ? current : oldest,
  );

  return {
    totalSizeBytes,
    fileCount: files.length,
    oldestFile: { path: oldestFile.path, mtime: oldestFile.mtime, size: oldestFile.size },
  };
}

export async function enforceQuota(
  dir: string,
  options: EnforceQuotaOptions,
): Promise<number> {
  const quotaMB = options.quotaMB ?? DEFAULT_QUOTA_MB;
  const quotaBytes = quotaMB * 1024 * 1024;
  const files = await collectFiles(dir, { logger: options.logger, quotaEnforcement: true });

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= quotaBytes) {
    return 0;
  }

  files.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  let currentSize = totalSize;
  let deletedCount = 0;

  for (const file of files) {
    if (currentSize <= quotaBytes) {
      break;
    }

    try {
      await Bun.file(file.path).delete();
      currentSize -= file.size;
      deletedCount++;
    } catch (error: unknown) {
      if (error instanceof Error) {
        const sysErr = error as { code?: string };
        if (sysErr.code === "ENOENT") {
          currentSize -= file.size;
          deletedCount++;
        } else {
          options.logger.warn("tool.output.cache.delete.failed", {
            error,
            meta: { path: file.path, quotaMB },
          });
        }
      }
    }
  }

  return deletedCount;
}
