import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowArtifactManager } from "../../agents/workflow/artifacts";
import { WorkflowStateManager } from "../../agents/workflow/state";
import { MemoryFileManager } from "../../memory/file-manager";
import type { ProjectContext } from "../../projects/types";
import { SkillService } from "../../skills";
import { createMemoryWriteTool, MemoryWriteInputSchema } from "./memory-write";
import { createMockStore } from "../../store/test-helpers";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../types";
import { ProjectApprovalManager } from "../permission";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");
const testSkillService = new SkillService({ builtinSkills: {} });

function makeFileManager(): MemoryFileManager {
  return new MemoryFileManager({
    project: join(TMP_DIR, "project"),
    user: join(TMP_DIR, "user"),
  });
}

function makeCtx(fileManager: MemoryFileManager, toolCallId = "call-1"): ToolExecutionContext {
  const workflowState = new WorkflowStateManager(TMP_DIR);
  const projectContext: ProjectContext = {
    project: { slug: "memory-write", name: "Memory Write", workspaceRoot: TMP_DIR, addedAt: new Date().toISOString() },
    workflowState,
    memory: fileManager,
    approvals: new ProjectApprovalManager(),
    artifacts: new WorkflowArtifactManager(TMP_DIR, workflowState),
  };
  return createToolExecutionContext({
    store: createMockStore(),
    toolName: "memory_write" as const,
    toolCallId,
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set<string>() as ReadonlySet<string>,
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
  });
}

function parseErrorResult(result: string | ToolExecutionResult): ToolExecutionResult {
  if (typeof result === "string") {
    throw new Error(`Expected error result, got success: ${result}`);
  }
  return result;
}

describe("MemoryWriteInputSchema", () => {
  it("accepts valid input with all fields", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic",
      description: "A description",
      type: "project",
      content: "Some content",
      scope: "project",
    });
    expect(result.success).toBe(true);
  });

  it("defaults scope to project", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic",
      description: "A description",
      type: "project",
      content: "Some content",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBeUndefined();
    }
  });

  it("makes description optional", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic",
      content: "Some content",
    });
    expect(result.success).toBe(true);
  });

  it("makes type optional", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic",
      content: "Some content",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic",
      description: "A description",
      type: "project",
      content: "Some content",
      extra: "not allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid type", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic",
      description: "A description",
      type: "invalid",
      content: "Some content",
    });
    expect(result.success).toBe(false);
  });

  it("rejects name with hyphens", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my-topic",
      description: "A description",
      type: "project",
      content: "Some content",
    });
    expect(result.success).toBe(false);
  });

  it("rejects name with path separators", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "knowledge/my_topic.md",
      description: "A description",
      type: "project",
      content: "Some content",
    });
    expect(result.success).toBe(false);
  });

  it("accepts name with underscores", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "my_topic_name",
      description: "A description",
      type: "project",
      content: "Some content",
    });
    expect(result.success).toBe(true);
  });

  it("accepts name with alphanumeric chars", () => {
    const result = MemoryWriteInputSchema.safeParse({
      name: "Topic123",
      description: "A description",
      type: "project",
      content: "Some content",
    });
    expect(result.success).toBe(true);
  });
});

describe("memory_write tool", () => {
  let fileManager: MemoryFileManager;

  beforeEach(async () => {
    await mkdir(join(TMP_DIR, "project", "knowledge"), { recursive: true });
    await mkdir(join(TMP_DIR, "user"), { recursive: true });
    fileManager = makeFileManager();
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("writes a valid topic and rebuilds index", async () => {
    const tool = createMemoryWriteTool();
    const result = await tool.execute(
      {
        name: "test_topic",
        description: "A test topic",
        type: "project",
        content: "This is test content.",
        scope: "project",
      },
      makeCtx(fileManager),
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("test_topic");

    const topic = await fileManager.readTopic("test_topic");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("test_topic");
    expect(topic!.description).toBe("A test topic");
    expect(topic!.type).toBe("project");
    expect(topic!.content).toBe("This is test content.");

    const index = await fileManager.readIndex();
    expect(index).not.toBeNull();
    expect(index!).toContain("test_topic");
  });

  it("rejects writing to index name", async () => {
    const tool = createMemoryWriteTool();
    const result = parseErrorResult(
      await tool.execute(
        {
          name: "index",
          description: "Should not work",
          type: "project",
          content: "Bad",
          scope: "project",
        },
        makeCtx(fileManager, "call-2"),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("index");
  });

  it("rejects content containing API keys", async () => {
    const tool = createMemoryWriteTool();
    const result = parseErrorResult(
      await tool.execute(
        {
          name: "secrets",
          description: "Contains secrets",
          type: "project",
          content: "My api_key=sk_test_1234567890abcdef1234567890abcd",
          scope: "project",
        },
        makeCtx(fileManager, "call-4"),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("secret");
  });

  it("rejects content containing passwords", async () => {
    const tool = createMemoryWriteTool();
    const result = parseErrorResult(
      await tool.execute(
        {
          name: "creds",
          description: "Contains password",
          type: "project",
          content: "Login with password=supersecretvalue123",
          scope: "project",
        },
        makeCtx(fileManager, "call-5"),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("secret");
  });

  it("updates existing file on duplicate name (idempotent)", async () => {
    const tool = createMemoryWriteTool();

    await tool.execute(
      {
        name: "duplicate",
        description: "First version",
        type: "project",
        content: "First content",
        scope: "project",
      },
      makeCtx(fileManager, "call-6"),
    );

    const result = await tool.execute(
      {
        name: "duplicate",
        description: "Second version",
        type: "reference",
        content: "Second content",
        scope: "project",
      },
      makeCtx(fileManager, "call-7"),
    );

    expect(typeof result).toBe("string");

    const topic = await fileManager.readTopic("duplicate");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("duplicate");
    expect(topic!.description).toBe("Second version");
    expect(topic!.type).toBe("reference");
    expect(topic!.content).toBe("Second content");
  });

  it("formats frontmatter correctly", async () => {
    const tool = createMemoryWriteTool();
    await tool.execute(
      {
        name: "frontmatter_test",
        description: "Testing frontmatter",
        type: "feedback",
        content: "Content here",
        scope: "project",
      },
      makeCtx(fileManager, "call-8"),
    );

    const resolvedPath = await fileManager.resolveProjectPath("knowledge/frontmatter_test.md");
    const file = Bun.file(resolvedPath);
    const content = await file.text();

    expect(content).toContain("---");
    expect(content).toContain("name: frontmatter_test");
    expect(content).toContain("description: Testing frontmatter");
    expect(content).toContain("type: feedback");
    expect(content).toContain("Content here");
  });

  it("writes user preferences when name='preferences' and scope='user'", async () => {
    const tool = createMemoryWriteTool();
    const result = await tool.execute(
      {
        name: "preferences",
        content: "I prefer dark mode",
        scope: "user",
      },
      makeCtx(fileManager, "call-9"),
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("user preferences");

    const prefs = await fileManager.readPreferences();
    expect(prefs).toBe("I prefer dark mode\n");
  });

  it("merges user preferences when preferences already exist", async () => {
    await fileManager.writePreferences("Existing preference\n");
    const tool = createMemoryWriteTool();
    const result = await tool.execute(
      {
        name: "preferences",
        content: "New preference",
        scope: "user",
      },
      makeCtx(fileManager, "call-10"),
    );

    expect(typeof result).toBe("string");
    const prefs = await fileManager.readPreferences();
    expect(prefs).toContain("Existing preference");
    expect(prefs).toContain("New preference");
  });

  it("rejects writing preferences with scope='project'", async () => {
    const tool = createMemoryWriteTool();
    const result = parseErrorResult(
      await tool.execute(
        {
          name: "preferences",
          content: "Should fail",
          scope: "project",
        },
        makeCtx(fileManager, "call-11"),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("user level");
  });

  it("defaults scope to user for preferences when scope not specified", async () => {
    const tool = createMemoryWriteTool();
    const result = await tool.execute(
      {
        name: "preferences",
        content: "I like vim",
      },
      makeCtx(fileManager, "call-12"),
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("user preferences");

    const prefs = await fileManager.readPreferences();
    expect(prefs).toBe("I like vim\n");
  });

  it("defaults scope to project for topics when scope not specified", async () => {
    const tool = createMemoryWriteTool();
    const result = await tool.execute(
      {
        name: "architecture",
        content: "Monorepo structure",
      },
      makeCtx(fileManager, "call-13"),
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("architecture");

    const topic = await fileManager.readTopic("architecture");
    expect(topic).not.toBeNull();
    expect(topic!.content).toBe("Monorepo structure");
  });

  it("rejects scope='user' for non-preferences names", async () => {
    const tool = createMemoryWriteTool();
    const result = parseErrorResult(
      await tool.execute(
        {
          name: "my_topic",
          content: "Should fail",
          scope: "user",
        },
        makeCtx(fileManager, "call-14"),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only");
    expect(result.output).toContain("preferences");
    expect(result.output).toContain("user level");
  });
});
