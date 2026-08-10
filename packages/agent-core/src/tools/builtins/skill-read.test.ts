import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SkillService } from "../../skills";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { createBuiltinToolDescriptors } from "./index";
import { formatResolvedSkillResource, SkillReadInputSchema, skillReadTool } from "./skill-read";

const tmpRoot = join(tmpdir(), "archcode-skill-read-tool", crypto.randomUUID());
const projectRoot = join(tmpRoot, "project");
const projectSkillsRoot = join(projectRoot, ".archcode", "skills");
const executionCwd = join(tmpRoot, "project.worktrees", "session-skill");
const executionSkillsRoot = join(executionCwd, ".archcode", "skills");
const userSkillsRoot = join(tmpRoot, "user", ".archcode", "skills");
const userAgentsSkillsRoot = join(tmpRoot, "user", ".agents", "skills");

function makeContext(agentSkills: readonly string[], cwd = projectRoot): ToolExecutionContext {
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "skill_read",
  toolCallId: "skill-read-call",
  input: {},
  step: 0,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["skill_read"]),
  agentSkills,
  skillService: new SkillService({ userSkillsRoot, userAgentsSkillsRoot }),
  projectContext: createTestProjectContext(projectRoot),
  cwd, });
}

async function writeProjectSkill(
  name: string,
  content: string,
  resources: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<void> {
  const skillDir = join(projectSkillsRoot, name);
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), content);
  for (const [path, resource] of Object.entries(resources)) {
    const destination = join(skillDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, resource);
  }
}

async function writeExecutionSkill(name: string, content: string): Promise<void> {
  const skillDir = join(executionSkillsRoot, name);
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), content);
}

describe("skill_read tool", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(userSkillsRoot, { recursive: true });
    await mkdir(userAgentsSkillsRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("entry read returns fixed metadata, root, sorted descriptors, and body without resource contents", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Maps code architecture and entry points when investigating an unfamiliar repository.
license: MIT
compatibility: Requires repository source access.
metadata:
  zeta: last
  alpha: first
---

ENTRY_BODY
`, {
      "references/z-last.md": "RESOURCE_Z",
      "references/a-first.md": "RESOURCE_A",
    });

    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"]));

    const output = expectTextDraft(result);
    expect(output).toContain("---\nname: codemap");
    expect(output).toContain(`source: ${join(projectSkillsRoot, "codemap")}`);
    expect(output).toContain(`root: ${join(projectSkillsRoot, "codemap")}`);
    expect(output).toContain("license: MIT");
    expect(output).toContain("compatibility: Requires repository source access.");
    expect(output).toContain('metadata: {"alpha":"first","zeta":"last"}');
    const headerKeys = output.split("---\n", 2)[1]!
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(headerKeys).toEqual([
      "name",
      "description",
      "source",
      "root",
      "license",
      "compatibility",
      "metadata",
    ]);
    expect(output.indexOf("references/a-first.md")).toBeLessThan(output.indexOf("references/z-last.md"));
    expect(output).toContain("ENTRY_BODY");
    expect(output).not.toContain("RESOURCE_A");
    expect(output).not.toContain("RESOURCE_Z");
  });

  test("entry read emits Resources: none for a package without supporting files", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Maps code architecture when investigating an unfamiliar repository.
---

ENTRY_BODY
`);

    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"]));
    expect(expectTextDraft(result)).toContain("Resources: none\n\n\nENTRY_BODY\n");
  });

  test("resource read returns exactly one UTF-8 resource with a fixed identity header", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Maps code architecture when investigating an unfamiliar repository.
---

ENTRY_BODY
`, {
      "references/guide.md": "RESOURCE_TEXT\n",
      "references/other.md": "OTHER_TEXT",
    });

    const result = await skillReadTool.execute(
      { name: "codemap", resource: "references/guide.md" },
      makeContext(["codemap"]),
    );

    expect(expectTextDraft(result)).toBe([
      "---",
      "skill: codemap",
      `source: ${join(projectSkillsRoot, "codemap")}`,
      "resource: references/guide.md",
      "bytes: 14",
      "---",
      "",
      "RESOURCE_TEXT\n",
    ].join("\n"));
    expect(expectTextDraft(result)).not.toContain("ENTRY_BODY");
    expect(expectTextDraft(result)).not.toContain("OTHER_TEXT");
  });

  test("binary resource read returns deterministic unsupported-binary identity and error", async () => {
    const result = formatResolvedSkillResource({
      skillName: "codemap",
      source: "builtin",
      sourceLabel: "builtin",
      resource: { path: "assets/image.bin", bytes: 3 },
      content: Uint8Array.from([0xff, 0xfe, 0xfd]),
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_SKILL_RESOURCE_BINARY_UNSUPPORTED");
    expect(expectTextDraft(result)).toBe([
      "---",
      "skill: codemap",
      "source: builtin",
      "resource: assets/image.bin",
      "bytes: 3",
      "---",
      "",
      "error: TOOL_SKILL_RESOURCE_BINARY_UNSUPPORTED",
      "hint: Binary Skill resources are valid package assets but cannot be returned by the text-only skill_read tool.",
    ].join("\n"));
  });

  test("unknown resource returns a structured error without lower-source fallback", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Maps code architecture when investigating an unfamiliar repository.
---

ENTRY_BODY
`);

    const result = await skillReadTool.execute(
      { name: "codemap", resource: "references/missing.md" },
      makeContext(["codemap"]),
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_SKILL_RESOURCE_NOT_FOUND");
  });

  test("unknown resource on an unresolved Skill reports the Skill-level error", async () => {
    const result = await skillReadTool.execute(
      { name: "missing-skill", resource: "references/missing.md" },
      makeContext(["missing-skill"]),
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_SKILL_NOT_FOUND");
    expect(expectTextDraft(result)).toContain(
      "Skill not found or not allowed for current agent: missing-skill",
    );
  });

  test("rejects traversal and absolute resource paths at the tool boundary", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Maps code architecture when investigating an unfamiliar repository.
---

ENTRY_BODY
`, { "references/guide.md": "guide" });

    for (const resource of ["../../etc/passwd", "references/../../escape.md", "/etc/passwd"]) {
      const result = await skillReadTool.execute(
        { name: "codemap", resource },
        makeContext(["codemap"]),
      );
      expect(result.isError).toBe(true);
      expect(result.details?.error?.code).toBe("TOOL_SKILL_INVALID");
    }
  });

  test("resolves same-name project Skills from the Session cwd", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Maps the canonical checkout when testing Skill resolution.
---

CANONICAL_SKILL_BODY
`);
    await writeExecutionSkill("codemap", `---
name: codemap
description: Maps the execution worktree when testing Skill resolution.
---

WORKTREE_SKILL_BODY
`);

    const result = await skillReadTool.execute(
      { name: "codemap" },
      makeContext(["codemap"], executionCwd),
    );

    const output = expectTextDraft(result);
    expect(output).toContain("WORKTREE_SKILL_BODY");
    expect(output).not.toContain("CANONICAL_SKILL_BODY");
  });

  test("reads the claimed execution Skill snapshot after the live package changes", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: Stable execution snapshot fixture.
---

ORIGINAL_ENTRY_BODY
`, { "references/guide.md": "ORIGINAL_RESOURCE\n" });
    const service = new SkillService({ userSkillsRoot });
    const snapshot = await service.snapshotForAgent(projectRoot, "codemap", ["codemap"]);
    if (snapshot === null) throw new Error("Expected the project Skill snapshot");

    await writeProjectSkill("codemap", `---
name: codemap
description: Changed live package.
---

CHANGED_ENTRY_BODY
`, { "references/guide.md": "CHANGED_RESOURCE\n" });
    const entryContext = makeContext(["codemap"]);
    entryContext.executionSkillSnapshots = new Map([["codemap", snapshot]]);
    const entry = await skillReadTool.execute({ name: "codemap" }, entryContext);
    const resource = await skillReadTool.execute(
      { name: "codemap", resource: "references/guide.md" },
      entryContext,
    );

    expect(expectTextDraft(entry)).toContain("ORIGINAL_ENTRY_BODY");
    expect(expectTextDraft(entry)).not.toContain("CHANGED_ENTRY_BODY");
    expect(expectTextDraft(resource)).toContain("ORIGINAL_RESOURCE");
    expect(expectTextDraft(resource)).not.toContain("CHANGED_RESOURCE");
  });

  test("not-allowed skill returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "git-master" },
      makeContext(["codemap"]),
    );

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Skill not found or not allowed for current agent: git-master");
    expect(result.details?.error).toBeDefined();
  });

  test("unknown skill name returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "missing-skill" },
      makeContext(["missing-skill"]),
    );

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Skill not found or not allowed for current agent: missing-skill");
    expect(result.details?.error).toBeDefined();
  });

  test("invalid skill name returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "../bad" },
      makeContext(["../bad"]),
    );

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Invalid Skill name");
    expect(result.details?.error).toBeDefined();
  });

  test("invalid skill file returns structured error", async () => {
    await writeProjectSkill("codemap", `---
name: wrong-name
description: invalid override
---

Broken body.
`);

    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"]));

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Invalid project-archcode skill");
    expect(result.details?.error).toBeDefined();
  });

  test("input schema accepts an optional listed resource and rejects authority overrides", () => {
    expect(SkillReadInputSchema.safeParse({ name: "codemap" }).success).toBe(true);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", resource: "references/guide.md" }).success).toBe(true);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", agentName: "lead" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", role: "builder" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", source: "builtin" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", path: "/tmp/SKILL.md" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", resource: "" }).success).toBe(false);
  });

  test("input schema rejects invalid skill names", () => {
    for (const invalidName of ["../x", "Git-Master", "double--hyphen", "trailing-", ""]) {
      expect(SkillReadInputSchema.safeParse({ name: invalidName }).success).toBe(false);
    }
  });

  test("model-facing schema is portable and omits the internal Skill-name regex", () => {
    const schema = (skillReadTool.aiInputSchema as { readonly jsonSchema: Record<string, unknown> }).jsonSchema;
    const serialized = JSON.stringify(schema);

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name"],
    });
    expect(serialized).not.toContain("pattern");
    expect(serialized).not.toContain("?!");
    expect(serialized).toContain("current-Agent Skill name");
    expect(serialized).toContain("target-scoped delegation result");
  });

  test("has correct read-only concurrency-safe traits and is registered", () => {
    expect(skillReadTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(createBuiltinToolDescriptors().some((tool) => tool.name === "skill_read")).toBe(true);
  });
});
