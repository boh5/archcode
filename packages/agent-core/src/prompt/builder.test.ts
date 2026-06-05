import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./builder";
import type { PromptContext } from "./types";

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return { allowedTools: ["file_read", "file_write"],
  workspaceRoot: "/home/user/project",
  promptProfileId: "default",
  env: {
    platform: "darwin",
    timezone: "America/Los_Angeles",
    locale: "en-US",
    cwd: "/home/user/project",
    date: "2025-01-15",
  }, ...overrides,  };
}

describe("buildSystemPrompt", () => {
  test("includes identity section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("Specra");
    expect(result).toContain("default");
  });

  test("includes guidelines section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("## Guidelines");
  });

  test("includes tools section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("## Tools");
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
  });

  test("includes workflow MVP instructions for orchestrator workflow tools", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: [
        "ask_user",
        "workflow_create",
        "workflow_update_stage",
        "workflow_complete",
        "workflow_record_completion",
        "artifact_read",
        "artifact_write",
      ],
    }));

    expect(result).toContain("## Workflow MVP Orchestration");
    expect(result).toContain("research_only");
    expect(result).toContain("quick_fix");
    expect(result).toContain("full_feature");
    expect(result).toContain("Use workflow_update_stage for every business-stage move");
    expect(result).toContain("record the current stage as completed with workflow_record_completion");
    expect(result).toContain("Use workflow_complete");
    expect(result).toContain("Use artifact_write for durable workflow artifacts");
    expect(result).toContain("Use artifact_read before relying on prior artifacts");
    expect(result).toContain("derived full_feature workflow");
  });

  test("includes environment section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("## Environment");
    expect(result).toContain("Platform: darwin");
  });

  test("omits project context when agentsMd is undefined", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentsMd: undefined }));
    expect(result).not.toContain("## Project Context");
  });

  test("includes project context when agentsMd is provided", async () => {
    const agentsMd = "# My Project\nSome instructions.";
    const result = await buildSystemPrompt(makeCtx({ agentsMd }));
    expect(result).toContain("## Project Context");
    expect(result).toContain("My Project");
  });

  test("includes project context when agentsMd is empty string", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentsMd: "" }));
    expect(result).toContain("## Project Context");
  });

  test("sections appear in correct order with skills section between guidelines and tools", async () => {
    const result = await buildSystemPrompt(makeCtx({
      promptProfileId: "builder",
      rolePrompt: "## Workflow Role: Builder\nTest content.",
      agentsMd: "AGENTSCONTENT",
      availableSkills: [{ name: "git-master", description: "Git expertise", when_to_use: "Use for git ops.", source: "builtin" }],
    }));
    const identityIdx = result.indexOf("Specra");
    const roleIdx = result.indexOf("## Workflow Role: Builder");
    const guidelinesIdx = result.indexOf("## Guidelines");
    const skillsIdx = result.indexOf("## Skills");
    const toolsIdx = result.indexOf("## Tools");
    const envIdx = result.indexOf("## Environment");
    const projectIdx = result.indexOf("## Project Context");

    expect(identityIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(guidelinesIdx);
    expect(guidelinesIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(projectIdx);
  });

  test("skills section is omitted when no available or active skills", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).not.toContain("## Skills");
    expect(result).not.toContain("<available-skills>");
    expect(result).not.toContain("<active-skills>");
  });

  test("omits role section when rolePrompt is absent", async () => {
    const result = await buildSystemPrompt(makeCtx({ rolePrompt: undefined }));

    expect(result).not.toContain("## Workflow Role:");
  });
});
