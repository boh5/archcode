import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_QUOTA_MB = 500;

export interface CacheStats {
  totalSizeBytes: number;
  fileCount: number;
  oldestFile: { path: string; mtime: Date; size: number } | null;
}

interface FileEntry {
  path: string;
  size: number;
  mtime: Date;
}

async function collectFiles(dir: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  let dirEntries;
  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error) {
      console.warn(
        `[tool-output-cache] Warning: cannot read directory ${dir}: ${error.message}`,
      );
    }
    return entries;
  }

  for (const entry of dirEntries) {
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const subEntries = await collectFiles(fullPath);
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
      console.warn("[tool-output-cache] skipping file:", e instanceof Error ? e.message : String(e));
      continue;
    }
  }

  return entries;
}

export async function getCacheStats(dir: string): Promise<CacheStats> {
  const files = await collectFiles(dir);

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
  quotaMB: number = DEFAULT_QUOTA_MB,
): Promise<number> {
  const quotaBytes = quotaMB * 1024 * 1024;
  const files = await collectFiles(dir);

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
          console.warn(
            `[tool-output-cache] Warning: cannot delete ${file.path}: ${error.message}`,
          );
        }
      }
    }
  }

  return deletedCount;
}
