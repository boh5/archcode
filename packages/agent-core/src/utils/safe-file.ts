import { chmod, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
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

export const ONE_SHOT_FILE_READ_MAX_BYTES = 8 * 1024 * 1024;

export class BoundedFileReadError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`File exceeds the safe one-shot read limit of ${maxBytes} bytes`);
    this.name = "BoundedFileReadError";
  }
}

/** Read a complete UTF-8 file or fail before returning any partial content. */
export async function readUtf8FileBounded(
  filePath: string,
  maxBytes = ONE_SHOT_FILE_READ_MAX_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Bounded file read limit must be a non-negative safe integer");
  }

  const size = (await stat(filePath)).size;
  if (size > maxBytes) throw new BoundedFileReadError(maxBytes);

  const handle = await open(filePath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: string[] = [];
  const buffer = new Uint8Array(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
  let total = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new BoundedFileReadError(maxBytes);
      chunks.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await handle.close();
  }
}

export function assertUtf8TextWithinLimit(
  content: string,
  maxBytes = ONE_SHOT_FILE_READ_MAX_BYTES,
): void {
  const bounded = new TextEncoder().encode(content);
  if (bounded.byteLength > maxBytes) throw new BoundedFileReadError(maxBytes);
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
