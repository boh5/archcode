import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SkillNotFoundError, SkillService, SkillValidationError } from "./service";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "skill-service", crypto.randomUUID());

function skillMarkdown(name: string, description = `${name} description`, body = `${name} body`, whenToUse = `Use when ${name} is needed.`): string {
  return `---
name: ${name}
description: ${description}
when_to_use: ${whenToUse}
---

${body}
`;
}

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  const filePath = join(root, name, "SKILL.md");
  await mkdir(join(root, name), { recursive: true });
  await Bun.write(filePath, content);
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

  test("resolves project skills before user and builtin without merging", async () => {
    await writeSkill(projectSkillsRoot, "git-master", skillMarkdown("git-master", "project git"));
    await writeSkill(userSkillsRoot, "git-master", skillMarkdown("git-master", "user git"));

    const service = new SkillService({ userSkillsRoot });
    const skill = await service.readForAgent(projectRoot, "git-master");

    expect(skill?.source).toBe("project");
    expect(skill?.metadata.description).toBe("project git");
    expect(skill?.path).toBe(join(projectSkillsRoot, "git-master", "SKILL.md"));
  });

  test("resolves user skills before builtin", async () => {
    await writeSkill(userSkillsRoot, "review-work", skillMarkdown("review-work", "user review"));

    const service = new SkillService({ userSkillsRoot });
    const skill = await service.readForAgent(projectRoot, "review-work");

    expect(skill?.source).toBe("user");
    expect(skill?.metadata.description).toBe("user review");
  });

  test("reserved creation skills cannot be shadowed by project or user skills", async () => {
    for (const name of ["goal-create", "automation-create"] as const) {
      await writeSkill(projectSkillsRoot, name, skillMarkdown(name, `project ${name}`));
      await writeSkill(userSkillsRoot, name, skillMarkdown(name, `user ${name}`));
    }

    const service = new SkillService({ userSkillsRoot });

    expect((await service.readForAgent(projectRoot, "goal-create"))?.source).toBe("builtin");
    expect((await service.readForAgent(projectRoot, "automation-create"))?.source).toBe("builtin");
  });

  test("reserved creation names remain unavailable rather than falling through when a test manifest omits them", async () => {
    await writeSkill(projectSkillsRoot, "goal-create", skillMarkdown("goal-create", "project override"));
    const service = new SkillService({ userSkillsRoot, builtinSkills: {} });

    expect(await service.readForAgent(projectRoot, "goal-create")).toBeNull();
  });

  test("falls back to statically bundled builtin manifest", async () => {
    const service = new SkillService({ userSkillsRoot });
    const skill = await service.readForAgent(projectRoot, "codemap");

    expect(skill?.source).toBe("builtin");
    expect(skill?.metadata.name).toBe("codemap");
    expect(skill?.body).toContain("Trace entry points");
  });

  test("does not fall back when a higher priority skill is invalid", async () => {
    await writeSkill(projectSkillsRoot, "codemap", `---
name: wrong-name
description: bad override
when_to_use: Use when broken.
---

Broken.
    `);

    const service = new SkillService({ userSkillsRoot });
    let thrown: unknown;
    try {
      await service.readForAgent(projectRoot, "codemap");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "SkillValidationError",
      source: "project",
      skillName: "codemap",
    } satisfies Partial<SkillValidationError>);
  });

  test("does not fall back when a higher priority skill file cannot be read", async () => {
    await mkdir(join(projectSkillsRoot, "codemap", "SKILL.md"), { recursive: true });

    const service = new SkillService({ userSkillsRoot });
    let thrown: unknown;
    try {
      await service.readForAgent(projectRoot, "codemap");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
  });

  test("lists only highest priority index entries and respects allowed names", async () => {
    await writeSkill(projectSkillsRoot, "safe-refactor", skillMarkdown("safe-refactor", "project safe"));
    await writeSkill(userSkillsRoot, "git-master", skillMarkdown("git-master", "user git"));

    const service = new SkillService({ userSkillsRoot });
    const entries = await service.listForAgent(projectRoot, ["git-master", "safe-refactor"]);

    expect(entries).toEqual([
      { name: "git-master", description: "user git", when_to_use: "Use when git-master is needed.", source: "user", allowed_tools: undefined },
      { name: "safe-refactor", description: "project safe", when_to_use: "Use when safe-refactor is needed.", source: "project", allowed_tools: undefined },
    ]);
  });

  test("rejects reads outside an agent allow-list", async () => {
    const service = new SkillService({ userSkillsRoot });
    let thrown: unknown;
    try {
      await service.readForAgent(projectRoot, "codemap", ["git-master"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "SkillNotFoundError",
      skillName: "codemap",
    } satisfies Partial<SkillNotFoundError>);
  });
});
