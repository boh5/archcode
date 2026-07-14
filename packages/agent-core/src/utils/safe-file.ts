import { chmod, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export class SafePathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Safe path error: ${reason} (path: "${path}")`);
    this.name = "SafePathError";
  }
}

export async function atomicWrite(
  filePath: string,
  content: string,
  options?: { readonly mode?: number },
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await Bun.write(tmpPath, content);
    if (options?.mode !== undefined) await chmod(tmpPath, options.mode);
  } catch (err) {
    try {
      await rm(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw new Error(
      `Failed to write temp file "${tmpPath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await rm(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw new Error(
      `Failed to rename "${tmpPath}" to "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function isContained(resolvedPath: string, root: string): boolean {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(root);
  return (
    normalizedResolved === normalizedRoot ||
    normalizedResolved.startsWith(normalizedRoot + "/")
  );
}

export async function resolveContainedPath(
  relative: string,
  root: string,
): Promise<string> {
  if (resolve(relative) === relative && !relative.startsWith(".")) {
    throw new SafePathError(relative, "Absolute paths are not allowed");
  }

  const normalized = resolve(root, relative);
  if (!isContained(normalized, root)) {
    throw new SafePathError(relative, "Path escapes the allowed root directory");
  }

  try {
    const realPath = await realpath(normalized);
    const realRoot = await realpath(root);
    if (!isContained(realPath, realRoot)) {
      throw new SafePathError(
        normalized,
        "Symlink resolves outside the allowed root directory",
      );
    }
    return realPath;
  } catch (error) {
    if (error instanceof SafePathError) throw error;
    return normalized;
  }
}
