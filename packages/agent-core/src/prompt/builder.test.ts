import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./builder";
import type { PromptContext } from "./types";

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    allowedTools: ["file_read", "file_write"],
    promptProfileId: "default",
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      projectRoot: "/home/user/project",
      cwd: "/home/user/project",
      date: "2025-01-15",
    },
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  test("includes identity, guidelines, tools, and environment sections", async () => {
    const result = await buildSystemPrompt(makeCtx());

    expect(result).toContain("ArchCode");
    expect(result).toContain("## Execution Contract");
    expect(result).toContain("## Tools");
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
    expect(result).toContain("## Environment");
    expect(result).toContain("Platform: darwin");
  });

  test("does not inject legacy workflow prompt sections", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: ["ask_user", "file_read"],
      rolePrompt: "## Goal Role: Engineer\nCoordinate goal execution.",
    }));

    expect(result).not.toContain("## Workflow MVP Orchestration");
    expect(result).not.toContain("## Active Workflow");
    expect(result).not.toContain("workflow_create");
  });

  test("omits project context when agentsMd is undefined", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentsMd: undefined }));
    expect(result).not.toContain("## Project Context");
  });

  test("includes project context when agentsMd is provided", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentsMd: "# My Project\nSome instructions." }));
    expect(result).toContain("## Project Context");
    expect(result).toContain("My Project");
  });

  test("sections appear in correct order with delegation between execution and skills", async () => {
    const result = await buildSystemPrompt(makeCtx({
      promptProfileId: "build",
      allowedTools: ["delegate", "file_read"],
      rolePrompt: "## Role: Build\nTest content.",
      agentsMd: "AGENTSCONTENT",
      availableSkills: [{ name: "git-master", description: "Git expertise", when_to_use: "Use for git ops.", source: "builtin" }],
    }));

    expect(result.indexOf("ArchCode")).toBeLessThan(result.indexOf("## Role: Build"));
    expect(result.indexOf("## Role: Build")).toBeLessThan(result.indexOf("## Execution Contract"));
    expect(result.indexOf("## Execution Contract")).toBeLessThan(result.indexOf("## Delegation Protocol"));
    expect(result.indexOf("## Delegation Protocol")).toBeLessThan(result.indexOf("## Skills"));
    expect(result.indexOf("## Skills")).toBeLessThan(result.indexOf("## Tools"));
    expect(result.indexOf("## Tools")).toBeLessThan(result.indexOf("## Environment"));
    expect(result.indexOf("## Environment")).toBeLessThan(result.indexOf("## Project Context"));
  });

  test("injects delegation protocol only when delegate is allowed", async () => {
    const withoutDelegate = await buildSystemPrompt(makeCtx({ allowedTools: ["file_read"] }));
    const withDelegate = await buildSystemPrompt(makeCtx({ allowedTools: ["file_read", "delegate"] }));

    expect(withoutDelegate).not.toContain("## Delegation Protocol");
    expect(withDelegate).toContain("## Delegation Protocol");
  });

  test("includes compression protocol instructions when compress is allowed", async () => {
    const withoutCompression = await buildSystemPrompt(makeCtx({ allowedTools: ["file_read"] }));
    const withCompress = await buildSystemPrompt(makeCtx({ allowedTools: ["file_read", "compress"] }));

    expect(withoutCompression).not.toContain("## Compression Protocol");
    expect(withoutCompression).not.toContain("model-callable tool");
    expect(withCompress).toContain("## Compression Protocol");
    expect(withCompress).toContain("runtime compact hook before model calls");
    expect(withCompress).toContain("startId/endId must be mNNNN refs or known bN block refs");
    expect(withCompress).toContain("(b1) exactly once");
    expect(withCompress).not.toContain("compact takes no input");
  });
});
