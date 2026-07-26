import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..");

async function productionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return await productionSourceFiles(path);
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (/\.(?:test|interaction)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [path];
  }));
  return files.flat();
}

test("keeps dynamic wall-clock ownership behind the Temporal primitive boundary", async () => {
  const files = await productionSourceFiles(SOURCE_ROOT);
  const directClockImporters: string[] = [];
  const directFormatterImporters: string[] = [];
  const businessIntervalOwners: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const sourcePath = relative(SOURCE_ROOT, file);
    if (/from\s+["'][^"']*time-clock["']/.test(source)) {
      directClockImporters.push(sourcePath);
    }
    if (/from\s+["'][^"']*time-format["']/.test(source)) {
      directFormatterImporters.push(sourcePath);
    }
    if (
      (sourcePath.startsWith("components/") || sourcePath.startsWith("routes/"))
      && /\bsetInterval\s*\(/.test(source)
    ) {
      businessIntervalOwners.push(sourcePath);
    }
  }

  expect(directClockImporters.sort()).toEqual(["components/primitives/TemporalText.tsx"]);
  expect(directFormatterImporters.sort()).toEqual(["components/primitives/TemporalText.tsx"]);
  expect(businessIntervalOwners).toEqual([]);
});
