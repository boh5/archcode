import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SkillService } from "../skills/service";
import { storeManager } from "../store/store";
import { createSkillCommand } from "./skill";
import { createTestTempRoot } from "../testing/test-temp-root";

const testTempRoot = createTestTempRoot("skill-command");
const TEST_WORKSPACE_ROOT = testTempRoot.path;

afterAll(async () => {
  await Promise.resolve();
  storeManager.clearAll();
  await testTempRoot.cleanup();
});

const gitMasterBody = "FULL GIT MASTER BODY MUST NOT LEAK";
const customSkillName = "custom-explicit";
const builtinSkills = {
  "git-master": {
    entry: `---\nname: git-master\ndescription: Git guidance. Use for git operations.\n---\n\n${gitMasterBody}`,
    resources: {},
  },
};

beforeAll(async () => {
  const validRoot = join(TEST_WORKSPACE_ROOT, ".archcode", "skills", customSkillName);
  await mkdir(validRoot, { recursive: true });
  await Bun.write(join(validRoot, "SKILL.md"), [
    "---",
    `name: ${customSkillName}`,
    "description: Custom explicit Skill outside the Agent builtin allow-list.",
    "---",
    "",
    "CUSTOM_EXPLICIT_BODY",
    "",
  ].join("\n"));

  const invalidRoot = join(TEST_WORKSPACE_ROOT, ".archcode", "skills", "invalid-custom");
  await mkdir(invalidRoot, { recursive: true });
  await Bun.write(join(invalidRoot, "SKILL.md"), [
    "---",
    "name: wrong-name",
    "description: Invalid custom Skill fixture.",
    "---",
    "",
    "INVALID_CUSTOM_BODY",
    "",
  ].join("\n"));
});

function createCommand(agentSkills: readonly string[] = ["git-master"]) {
  const skillService = new SkillService({ builtinSkills });
  return {
    command: createSkillCommand(),
    context: {
      store: storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" }),
      binding: undefined as never,
      cwd: TEST_WORKSPACE_ROOT,
      agentName: "test-agent",
      agentSkills,
      skillService,
    },
  };
}

async function run(args?: string, agentSkills?: readonly string[]) {
  const { command, context } = createCommand(agentSkills);
  return command.handler(context, args);
}

describe("createSkillCommand", () => {
  test("/skill use git-master commit changes returns a pending message", async () => {
    const result = await run("use git-master commit changes");

    expect(result.success).toBe(true);
    expect(result.message).toBe('Activating skill "git-master"...');
    expect(result.pendingMessage).toEqual({
      content: "commit changes",
      executionSkillNames: ["git-master"],
    });
    expect(result).not.toHaveProperty("continueAsMessage");
  });

  test("/skill use git-master without request uses default request text", async () => {
    const result = await run("use git-master");

    expect(result.success).toBe(true);
    expect(result.pendingMessage).toEqual({
      content: "Apply this Skill to the current task.",
      executionSkillNames: ["git-master"],
    });
    expect(result).not.toHaveProperty("continueAsMessage");
  });

  test("/skill use without name returns helpful error", async () => {
    const result = await run("use");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Missing skill name");
    expect(result.message).toContain("/skill use <name>");
  });

  test("/skill without subcommand returns syntax help", async () => {
    const result = await run("");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unsupported /skill command");
    expect(result.message).toContain("/skill use <name>");
  });

  test("unknown skill returns not available error", async () => {
    const result = await run("use unknown-skill");

    expect(result.success).toBe(false);
    expect(result.message).toContain('Skill "unknown-skill" is not available for current agent');
  });

  test("skill outside current agent allow-list returns not available error", async () => {
    const result = await run("use git-master", ["codemap"]);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Skill "git-master" is not available for current agent');
  });

  test("custom winning Skill outside the builtin allow-list remains available", async () => {
    const result = await run(`use ${customSkillName}`, []);

    expect(result.success).toBe(true);
    expect(result.pendingMessage).toEqual({
      content: "Apply this Skill to the current task.",
      executionSkillNames: [customSkillName],
    });
  });

  test("invalid custom winner is rejected", async () => {
    const result = await run("use invalid-custom", []);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Skill "invalid-custom" is invalid:');
  });

  test("pending message does not include full skill body", async () => {
    const result = await run("use git-master commit changes");

    expect(result.message).not.toContain(gitMasterBody);
    expect(result.pendingMessage?.content).not.toContain(gitMasterBody);
    expect(result).not.toHaveProperty("continueAsMessage");
  });
});
