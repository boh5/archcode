import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewableSourceSet } from "./reviewable-source";

const root = join(tmpdir(), "archcode-reviewable-source-" + crypto.randomUUID());

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ReviewableSourceSet", () => {
  test("keeps tracked ignored-name outputs reviewable and excludes Git-ignored caches", async () => {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "dist/\ncache/\n");
    await writeFile(join(root, "dist", "app.js"), "export {};\n");
    await git(["init"]);
    await git(["add", ".gitignore"]);
    await git(["add", "-f", "dist/app.js"]);

    const sources = await ReviewableSourceSet.create(root);

    expect(sources.paths.has("dist/app.js")).toBe(true);
    expect(await sources.containsEventPath("dist/app.js")).toBe(true);
    expect(await sources.containsEventPath("dist")).toBe(true);
    expect(await sources.containsEventPath("cache")).toBe(false);
    expect(await sources.containsEventPath("cache/result.json")).toBe(false);
    expect(await sources.containsEventPath(".archcode/runtime.json")).toBe(false);
  });

  test("uses a fail-closed all-workspace set outside Git", async () => {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "generated.js"), "export {};\n");

    const sources = await ReviewableSourceSet.create(root);

    expect(sources.isGitWorkspace).toBe(false);
    expect(sources.paths.has("node_modules/generated.js")).toBe(true);
    expect(await sources.containsEventPath("build/output.js")).toBe(true);
  });
});

async function git(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
}
