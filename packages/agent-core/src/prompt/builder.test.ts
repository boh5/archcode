import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./builder";
import type { PromptContext } from "./types";

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    allowedTools: ["file_read", "file_write"],
    workspaceRoot: "/home/user/project",
    agentId: "default",
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

  test("sections appear in correct order", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentId: "builder", rolePrompt: "## Workflow Role: Builder\nTest content.", agentsMd: "AGENTSCONTENT" }));
    const identityIdx = result.indexOf("Specra");
    const roleIdx = result.indexOf("## Workflow Role: Builder");
    const guidelinesIdx = result.indexOf("## Guidelines");
    const toolsIdx = result.indexOf("## Tools");
    const envIdx = result.indexOf("## Environment");
    const projectIdx = result.indexOf("## Project Context");

    expect(identityIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(guidelinesIdx);
    expect(guidelinesIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(projectIdx);
  });

  test("omits role section when rolePrompt is absent", async () => {
    const result = await buildSystemPrompt(makeCtx({ rolePrompt: undefined }));

    expect(result).not.toContain("## Workflow Role:");
  });
});
