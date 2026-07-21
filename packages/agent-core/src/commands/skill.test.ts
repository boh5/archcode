import { afterAll, describe, expect, test } from "bun:test";
import { SkillService } from "../skills/service";
import { storeManager } from "../store/store";
import { createSkillCommand } from "./skill";
import { createTestTempRoot } from "../testing/test-temp-root";

const testTempRoot = createTestTempRoot("skill-command");
const TEST_WORKSPACE_ROOT = testTempRoot.path;

afterAll(async () => {
  await Bun.sleep(0);
  storeManager.clearAll();
  await testTempRoot.cleanup();
});

const gitMasterBody = "FULL GIT MASTER BODY MUST NOT LEAK";
const builtinSkills = {
  "git-master": `---\nname: git-master\ndescription: Git guidance.\nwhen_to_use: Use for git operations.\n---\n\n${gitMasterBody}`,
};

function createCommand(agentSkills: readonly string[] = ["git-master"]) {
  const skillService = new SkillService({ builtinSkills });
  return {
    command: createSkillCommand(),
    context: {
      store: storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, { agentName: "lead" }),
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
  test("/skill use git-master commit changes returns continuation message", async () => {
    const result = await run("use git-master commit changes");

    expect(result.success).toBe(true);
    expect(result.message).toBe('Activating skill "git-master"...');
    expect(result.continueAsMessage).toContain("skill_read");
    expect(result.continueAsMessage).toContain('{"name":"git-master"}');
    expect(result.continueAsMessage).toContain("commit changes");
  });

  test("/skill use git-master without request uses default request text", async () => {
    const result = await run("use git-master");

    expect(result.success).toBe(true);
    expect(result.continueAsMessage).toContain("Apply this Skill to the current task.");
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

  test("continuation message does not include full skill body", async () => {
    const result = await run("use git-master commit changes");

    expect(result.message).not.toContain(gitMasterBody);
    expect(result.continueAsMessage).not.toContain(gitMasterBody);
  });
});
