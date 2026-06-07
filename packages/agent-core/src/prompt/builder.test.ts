import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./builder";
import type { PromptContext } from "./types";

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    allowedTools: ["file_read", "file_write"],
    workspaceRoot: "/home/user/project",
    promptProfileId: "default",
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      cwd: "/home/user/project",
      date: "2025-01-15",
    },
    ...overrides,
  };
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

  test("Active Workflow section includes exact workflow details and UUID rules for workflow-capable tools", async () => {
    const workflowId = "550e8400-e29b-41d4-a716-446655440000";
    const workflowTitle = "Implement UUID workflow context";
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: ["ask_user", "workflow_create", "workflow_read", "artifact_read"],
      activeWorkflow: {
        id: workflowId,
        title: workflowTitle,
        type: "full_feature",
        stage: "foreman_executing",
        status: "active",
      },
    }));

    expect(result).toContain("## Active Workflow");
    expect(result).toContain(`Workflow ID: ${workflowId}`);
    expect(result).toContain(`Title: ${workflowTitle}`);
    expect(result).toContain("Type: full_feature");
    expect(result).toContain("Stage: foreman_executing");
    expect(result).toContain("Status: active");
    expect(result).toContain(`Use the exact workflow UUID \`${workflowId}\``);
    expect(result).toContain("all workflow and artifact tool calls");
    expect(result).toContain("Never invent workflow IDs");
    expect(result).toContain("Never use `default`, a slug, or a title as a workflow ID");
    expect(result).toContain(workflowTitle);
    expect(result).toContain("Use any other workflow UUID only when an explicit read reference provides that UUID");

    const gateIdx = result.indexOf("## Workflow MVP Orchestration");
    const activeIdx = result.indexOf("## Active Workflow");
    const toolsIdx = result.indexOf("## Tools");
    expect(activeIdx).toBeGreaterThan(gateIdx);
    expect(activeIdx).toBeLessThan(toolsIdx);
  });

  test("Active Workflow section is omitted when no active workflow exists", async () => {
    const result = await buildSystemPrompt(makeCtx({ allowedTools: ["workflow_read", "artifact_read"] }));

    expect(result).not.toContain("## Active Workflow");
  });

  test("Active Workflow section is omitted when tools are not workflow-capable", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: ["file_read", "grep"],
      activeWorkflow: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        title: "Hidden workflow",
        type: "research_only",
        stage: "researching",
        status: "active",
      },
    }));

    expect(result).not.toContain("## Active Workflow");
    expect(result).not.toContain("Hidden workflow");
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
