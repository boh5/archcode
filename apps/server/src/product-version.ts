import { join } from "node:path";

const workspacePackageJsonPath = join(import.meta.dir, "..", "..", "..", "package.json");

export async function readSourceProductVersion(): Promise<string> {
  const packageJson = await Bun.file(workspacePackageJsonPath).json() as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Root package.json must contain a product version");
  }
  return packageJson.version;
}
