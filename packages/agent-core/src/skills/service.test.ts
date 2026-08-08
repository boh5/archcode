import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuiltinSkillPackage } from "./types";
import {
  RESERVED_BUILTIN_SKILL_NAMES,
  SkillPathError,
  SkillResourceNotFoundError,
  SkillService,
  SkillValidationError,
} from "./service";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "service", crypto.randomUUID());

function skillMarkdown(
  name: string,
  description = `${name} guides work when ${name} is needed.`,
  body = `${name} body`,
): string {
  return `---
name: ${name}
description: ${description}
---

${body}
`;
}

function builtinSkill(name: string, body: string, resources: BuiltinSkillPackage["resources"] = {}): BuiltinSkillPackage {
  return { entry: skillMarkdown(name, `${name} builtin guidance when builtin behavior is needed.`, body), resources };
}

async function writeSkill(
  root: string,
  name: string,
  content: string,
  resources: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<string> {
  const packageRoot = join(root, name);
  await mkdir(packageRoot, { recursive: true });
  await Bun.write(join(packageRoot, "SKILL.md"), content);
  for (const [path, value] of Object.entries(resources)) {
    const destination = join(packageRoot, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, value);
  }
  return packageRoot;
}

describe("SkillService", () => {
  const projectRoot = join(tmpRoot, "project");
  const projectSkillsRoot = join(projectRoot, ".archcode", "skills");
  const userSkillsRoot = join(tmpRoot, "user", ".archcode", "skills");

  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userSkillsRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("resolves one atomic package with project > user > builtin precedence", async () => {
    const projectPackageRoot = await writeSkill(
      projectSkillsRoot,
      "codemap",
      skillMarkdown("codemap", "Project mapping when this checkout is under investigation.", "PROJECT_ENTRY"),
      { "references/project.md": "PROJECT_RESOURCE" },
    );
    await writeSkill(
      userSkillsRoot,
      "codemap",
      skillMarkdown("codemap", "User mapping when any checkout is under investigation.", "USER_ENTRY"),
      { "references/user.md": "USER_RESOURCE" },
    );
    const service = new SkillService({
      userSkillsRoot,
      builtinSkills: { codemap: builtinSkill("codemap", "BUILTIN_ENTRY", { "references/builtin.md": "BUILTIN_RESOURCE" }) },
    });

    const skill = await service.readForAgent(projectRoot, "codemap", ["codemap"]);

    expect(skill).toEqual({
      metadata: {
        name: "codemap",
        description: "Project mapping when this checkout is under investigation.",
      },
      body: "\nPROJECT_ENTRY\n",
      source: "project",
      sourceLabel: projectPackageRoot,
      root: projectPackageRoot,
      resources: [{ path: "references/project.md", bytes: 16 }],
    });
  });

  test("resolves user before builtin when no project package exists", async () => {
    await writeSkill(userSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "User mapping when a checkout is under investigation.",
      "USER_ENTRY",
    ));
    const service = new SkillService({
      userSkillsRoot,
      builtinSkills: { codemap: builtinSkill("codemap", "BUILTIN_ENTRY") },
    });

    expect((await service.readForAgent(projectRoot, "codemap", ["codemap"]))?.source).toBe("user");
  });

  test("never falls through to a lower package for an unlisted resource", async () => {
    await writeSkill(projectSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "Project mapping when this checkout is under investigation.",
    ));
    await writeSkill(userSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "User mapping when a checkout is under investigation.",
    ), { "references/lower.md": "LOWER_RESOURCE" });
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    await expect(service.readResourceForAgent(
      projectRoot,
      "codemap",
      "references/lower.md",
      ["codemap"],
    )).rejects.toBeInstanceOf(SkillResourceNotFoundError);
  });

  test("fails closed when the winning package is invalid", async () => {
    await writeSkill(projectSkillsRoot, "codemap", skillMarkdown(
      "wrong-name",
      "Broken project override when validating precedence.",
    ));
    await writeSkill(userSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "Valid user package when validating precedence.",
    ));
    const service = new SkillService({ userSkillsRoot });

    try {
      await service.readForAgent(projectRoot, "codemap", ["codemap"]);
      throw new Error("Expected invalid winning package to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "SkillValidationError",
        source: "project",
        skillName: "codemap",
      } satisfies Partial<SkillValidationError>);
    }
  });

  test("fails closed when the winning SKILL.md is unreadable", async () => {
    await mkdir(join(projectSkillsRoot, "codemap", "SKILL.md"), { recursive: true });
    await writeSkill(userSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "Valid user package when validating unreadable precedence.",
    ));
    const service = new SkillService({ userSkillsRoot });

    await expect(service.readForAgent(projectRoot, "codemap", ["codemap"]))
      .rejects.toMatchObject({ source: "project", skillName: "codemap" });
  });

  test("fails closed when the winning package directory has no SKILL.md", async () => {
    await mkdir(join(projectSkillsRoot, "codemap"), { recursive: true });
    await writeSkill(userSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "Valid user package when a missing project entry is checked.",
    ));
    const service = new SkillService({ userSkillsRoot });

    await expect(service.readForAgent(projectRoot, "codemap", ["codemap"]))
      .rejects.toMatchObject({ source: "project", skillName: "codemap" });
  });

  test("does not touch a damaged lower user package after resolving a valid project winner", async () => {
    await writeSkill(projectSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "Valid project mapping when lower sources are damaged.",
      "PROJECT_ENTRY",
    ), { "references/project.md": "PROJECT_RESOURCE" });
    const damagedUserRoot = join(userSkillsRoot, "codemap");
    await mkdir(damagedUserRoot, { recursive: true });
    await Bun.write(join(damagedUserRoot, "SKILL.md"), "not valid Skill Markdown");
    await symlink(join(tmpRoot, "outside"), join(damagedUserRoot, "linked-resource"));
    const service = new SkillService({ userSkillsRoot });

    const skill = await service.readForAgent(projectRoot, "codemap", ["codemap"]);
    expect(skill?.source).toBe("project");
    expect(skill?.body).toContain("PROJECT_ENTRY");
    expect(skill?.resources).toEqual([{ path: "references/project.md", bytes: 16 }]);
  });

  test("re-resolves the current winner independently on every entry and resource read", async () => {
    await writeSkill(userSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "User mapping when a checkout is under investigation.",
      "USER_ENTRY",
    ), { "references/user.md": "USER_RESOURCE" });
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    expect((await service.readForAgent(projectRoot, "codemap", ["codemap"]))?.source).toBe("user");

    await writeSkill(projectSkillsRoot, "codemap", skillMarkdown(
      "codemap",
      "Project mapping when this checkout is under investigation.",
      "PROJECT_ENTRY",
    ), { "references/project.md": "PROJECT_RESOURCE" });

    const projectResource = await service.readResourceForAgent(
      projectRoot,
      "codemap",
      "references/project.md",
      ["codemap"],
    );
    expect(projectResource?.source).toBe("project");
    expect(new TextDecoder().decode(projectResource?.content)).toBe("PROJECT_RESOURCE");
    await expect(service.readResourceForAgent(projectRoot, "codemap", "references/user.md", ["codemap"]))
      .rejects.toBeInstanceOf(SkillResourceNotFoundError);
  });

  test("reserved lifecycle builtins are unshadowable and Agent-gated", async () => {
    const builtinSkills: Record<string, BuiltinSkillPackage> = {};
    for (const name of RESERVED_BUILTIN_SKILL_NAMES) {
      builtinSkills[name] = builtinSkill(name, `BUILTIN_${name}`);
      await writeSkill(projectSkillsRoot, name, skillMarkdown(
        name,
        `Project override when ${name} is activated.`,
        `PROJECT_${name}`,
      ));
      await writeSkill(userSkillsRoot, name, skillMarkdown(
        name,
        `User override when ${name} is activated.`,
        `USER_${name}`,
      ));
    }
    const service = new SkillService({ userSkillsRoot, builtinSkills });

    for (const name of RESERVED_BUILTIN_SKILL_NAMES) {
      const skill = await service.readForAgent(projectRoot, name, [name]);
      expect(skill?.source).toBe("builtin");
      expect(skill?.body).toContain(`BUILTIN_${name}`);
      expect(await service.readForAgent(projectRoot, name, ["codemap"])).toBeNull();
    }
    const listed = (await service.listForAgent(projectRoot, ["codemap"]))
      .map((entry) => entry.name);
    for (const name of RESERVED_BUILTIN_SKILL_NAMES) {
      expect(listed).not.toContain(name);
    }
  });

  test("lists custom packages regardless of builtin allow-list and only eligible builtins", async () => {
    await writeSkill(projectSkillsRoot, "team-conventions", skillMarkdown(
      "team-conventions",
      "Applies team conventions when changing this project.",
    ));
    const service = new SkillService({
      userSkillsRoot,
      builtinSkills: {
        codemap: builtinSkill("codemap", "CODEMAP"),
        "git-master": builtinSkill("git-master", "GIT"),
      },
    });

    expect(await service.listForAgent(projectRoot, ["codemap"])).toEqual([
      {
        name: "codemap",
        description: "codemap builtin guidance when builtin behavior is needed.",
        source: "builtin",
      },
      {
        name: "team-conventions",
        description: "Applies team conventions when changing this project.",
        source: "project",
      },
    ]);
    expect(await service.readForAgent(projectRoot, "git-master", ["codemap"])).toBeNull();
  });

  test("metadata discovery does not read the body or walk package resources", async () => {
    const packageRoot = await writeSkill(
      projectSkillsRoot,
      "codemap",
      skillMarkdown(
        "codemap",
        "Maps code when repository discovery is needed.",
        "VALID_PREFIX",
      ),
    );
    await Bun.write(join(packageRoot, "SKILL.md"), new Blob([
      skillMarkdown(
        "codemap",
        "Maps code when repository discovery is needed.",
        "VALID_PREFIX",
      ),
      Uint8Array.from([0xff]),
    ]));
    await symlink(join(tmpRoot, "outside"), join(packageRoot, "linked-resources"));
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    expect(await service.listForAgent(projectRoot, [])).toEqual([{
      name: "codemap",
      description: "Maps code when repository discovery is needed.",
      source: "project",
    }]);
    await expect(service.readForAgent(projectRoot, "codemap", []))
      .rejects.toMatchObject({ source: "project", skillName: "codemap" });
  });

  test("ignores non-directory discovery entries and validates directory-name equality", async () => {
    await mkdir(projectSkillsRoot, { recursive: true });
    await Bun.write(join(projectSkillsRoot, "plain-file"), skillMarkdown(
      "plain-file",
      "A plain file that must not be discovered as a package.",
    ));
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });
    expect(await service.listForAgent(projectRoot, [])).toEqual([]);

    await rm(join(projectSkillsRoot, "plain-file"));
    await writeSkill(projectSkillsRoot, "directory-name", skillMarkdown(
      "different-name",
      "A mismatched package when directory identity is checked.",
    ));

    await expect(service.listForAgent(projectRoot, [])).rejects.toMatchObject({
      source: "project",
      skillName: "directory-name",
    });
  });

  test("rejects a symlinked project package root through list and direct read", async () => {
    const externalPackage = join(tmpRoot, "external", "symlink-skill");
    await writeSkill(
      join(tmpRoot, "external"),
      "symlink-skill",
      skillMarkdown(
        "symlink-skill",
        "External guidance when symlink boundaries are being checked.",
      ),
    );
    await mkdir(projectSkillsRoot, { recursive: true });
    await symlink(externalPackage, join(projectSkillsRoot, "symlink-skill"), "dir");
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    await expect(service.listForAgent(projectRoot, []))
      .rejects.toBeInstanceOf(SkillPathError);
    await expect(service.readForAgent(projectRoot, "symlink-skill", []))
      .rejects.toBeInstanceOf(SkillPathError);
  });

  test("rejects a project skills-root symlink that points outside the workspace", async () => {
    const externalSkillsRoot = join(tmpRoot, "external-skills-root");
    await writeSkill(
      externalSkillsRoot,
      "escaped-skill",
      skillMarkdown(
        "escaped-skill",
        "External guidance when source-root ancestry is being checked.",
      ),
    );
    await mkdir(join(projectRoot, ".archcode"), { recursive: true });
    await rm(projectSkillsRoot, { recursive: true, force: true });
    await symlink(externalSkillsRoot, projectSkillsRoot, "dir");
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    await expect(service.listForAgent(projectRoot, []))
      .rejects.toBeInstanceOf(SkillPathError);
    await expect(service.readForAgent(projectRoot, "escaped-skill", []))
      .rejects.toBeInstanceOf(SkillPathError);
  });

  test("rejects a source-root symlink before list discovery reads external names", async () => {
    const emptyExternalSkillsRoot = join(tmpRoot, "empty-external-skills-root");
    await mkdir(emptyExternalSkillsRoot, { recursive: true });
    await mkdir(join(projectRoot, ".archcode"), { recursive: true });
    await rm(projectSkillsRoot, { recursive: true, force: true });
    await symlink(emptyExternalSkillsRoot, projectSkillsRoot, "dir");
    const service = new SkillService({
      userSkillsRoot,
      builtinSkills: { codemap: builtinSkill("codemap", "BUILTIN") },
    });

    await expect(service.listForAgent(projectRoot, []))
      .rejects.toBeInstanceOf(SkillPathError);
    await expect(service.readForAgent(projectRoot, "codemap", ["codemap"]))
      .rejects.toBeInstanceOf(SkillPathError);
  });

  test("does not resolve inherited object properties as builtin Skill names", async () => {
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    expect(await service.discoverForAgent(projectRoot, "constructor", ["constructor"]))
      .toBeNull();
    expect(await service.readForAgent(projectRoot, "constructor", ["constructor"]))
      .toBeNull();
  });
});
