import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { activateBuiltinSkill } from "../package-reader";
import { SkillService } from "../service";
import { BUILTIN_SKILL_PACKAGES } from "./manifest";

const builtinRoot = import.meta.dir;

describe("builtin Skill package manifest", () => {
  test("declares exactly every builtin package directory", async () => {
    const sourceNames = (await readdir(builtinRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const manifestNames = Object.keys(BUILTIN_SKILL_PACKAGES).sort();

    expect(sourceNames).toHaveLength(14);
    expect(manifestNames).toEqual(sourceNames);
  });

  test("declares every non-entry source file once with no embedded extras", async () => {
    for (const [name, skillPackage] of Object.entries(BUILTIN_SKILL_PACKAGES)) {
      const sourceFiles = await listRelativeFiles(join(builtinRoot, name));
      expect(Object.keys(skillPackage.resources).sort()).toEqual(
        sourceFiles.filter((path) => path !== "SKILL.md"),
      );

      const activated = activateBuiltinSkill(skillPackage, name);
      expect(activated.metadata.name).toBe(name);
      expect(activated.resources.map((resource) => resource.path)).toEqual(
        Object.keys(skillPackage.resources).sort(),
      );
    }
  });

  test("reads a real multi-file builtin through the ordinary SkillService path", async () => {
    const service = new SkillService({
      userSkillsRoot: join(builtinRoot, "__definitely_missing_user_skills__"),
    });

    const entry = await service.readForAgent(builtinRoot, "codemap", ["codemap"]);
    expect(entry?.source).toBe("builtin");
    expect(entry?.resources).toContainEqual({
      path: "references/evidence-map-example.md",
      bytes: expect.any(Number),
    });
    expect(entry?.body).not.toContain("## Evidence Map Example");

    const resource = await service.readResourceForAgent(
      builtinRoot,
      "codemap",
      "references/evidence-map-example.md",
      ["codemap"],
    );
    expect(resource?.source).toBe("builtin");
    expect(new TextDecoder().decode(resource?.content)).toContain("Evidence map shape");
  });
});

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string, prefix: readonly string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = [...prefix, entry.name];
      if (entry.isSymbolicLink()) throw new Error(`Builtin source contains a symlink: ${path.join("/")}`);
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path.join("/"));
      } else {
        throw new Error(`Builtin source contains a non-file entry: ${path.join("/")}`);
      }
    }
  }

  await walk(root, []);
  return files.sort();
}
