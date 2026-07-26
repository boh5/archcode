import {
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode: number = 0o600,
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  mode: number,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    const file = await open(temporaryPath, "wx", mode);
    temporaryExists = true;
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    temporaryExists = false;
    await syncDirectory(directory);
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
