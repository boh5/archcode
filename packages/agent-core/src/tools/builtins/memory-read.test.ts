import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryReadTool } from "./memory-read";
import { MemoryFileManager } from "../../memory";
import { WorkflowArtifactManager } from "../../agents/workflow/artifacts";
import { WorkflowStateManager } from "../../agents/workflow/state";
import { storeManager } from "../../store/store";
import type { ProjectContext } from "../../projects/types";
import { silentLogger } from "../../logger";
import { ProjectApprovalManager } from "../permission";
import {
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_FILE,
  INDEX_TRUNCATION_SUFFIX,
  KNOWLEDGE_DIR_NAME,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  PREFERENCES_FILE,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
} from "../../memory/constants";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../types";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const testDir = join(import.meta.dir, "__test_tmp__", "memory-read");
const projectDir = join(testDir, "project");
const userDir = join(testDir, "user");
const knowledgeDir = join(projectDir, KNOWLEDGE_DIR_NAME);

let fileManager: MemoryFileManager;
let memoryReadTool: ReturnType<typeof createMemoryReadTool>;
const testSkillService = new SkillService({ builtinSkills: {} });

beforeAll(async () => {
  await mkdir(projectDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  fileManager = new MemoryFileManager({ project: projectDir, user: userDir });
  memoryReadTool = createMemoryReadTool();
});

beforeEach(async () => {
  // Clean all files between tests
  await rm(join(projectDir, INDEX_FILE), { force: true });
  await rm(join(userDir, PREFERENCES_FILE), { force: true });
  // Clean knowledge dir contents
  const knowledgeFiles = await Array.fromAsync(
    new Bun.Glob("*").scan({ cwd: knowledgeDir, absolute: true }),
  );
  for (const f of knowledgeFiles) {
    await rm(f, { force: true });
  }
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIndexEntries(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `- [Topic ${i}](topic_${i}) — Summary for topic ${i}`,
  ).join("\n") + "\n";
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const workspaceRoot = overrides.projectContext?.project.workspaceRoot ?? testDir;
  const workflowState = new WorkflowStateManager(workspaceRoot);
  const projectContext: ProjectContext = overrides.projectContext ?? {
    project: { slug: "memory-read", name: "Memory Read", workspaceRoot, addedAt: new Date().toISOString() },
    workflowState,
    memory: fileManager,
    approvals: new ProjectApprovalManager(silentLogger),
    artifacts: new WorkflowArtifactManager(workspaceRoot, workflowState),
  };
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "memory_read",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["memory_read"]),
  agentSkills: [],
  skillService: testSkillService,
  projectContext,
  ...overrides, });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMemoryReadTool", () => {
  describe("no-arg call (combined context)", () => {
    test("returns combined context with user preferences and index in correct order", async () => {
      await Bun.write(join(projectDir, INDEX_FILE), "- [Alpha](alpha) — First topic\n");
      await Bun.write(join(userDir, PREFERENCES_FILE), "User likes simplicity.");

      const result = (await memoryReadTool.execute(
        {},
        makeCtx(),
      )) as string;

      expect(result).toContain(MEMORY_CONTEXT_START);
      expect(result).toContain(MEMORY_CONTEXT_END);
      expect(result).toContain("## Memory Index");
      expect(result).toContain("- [Alpha](alpha) — First topic");
      expect(result).toContain(PREFERENCES_MARKER_START);
      expect(result).toContain("User likes simplicity.");
      expect(result).toContain(PREFERENCES_MARKER_END);

      // Verify order: user preferences → index
      const userPrefIdx = result.indexOf(PREFERENCES_MARKER_START);
      const indexIdx = result.indexOf("## Memory Index");
      expect(userPrefIdx).toBeLessThan(indexIdx);
    });

    test("returns context with no content when no files exist", async () => {
      const result = (await memoryReadTool.execute(
        {},
        makeCtx(),
      )) as string;

      expect(result).toBe(`${MEMORY_CONTEXT_START}\n\n${MEMORY_CONTEXT_END}`);
    });

    test("truncates index when exceeding max lines", async () => {
      const manyLines = createIndexEntries(DEFAULT_MAX_INDEX_LINES + 10);
      await Bun.write(join(projectDir, INDEX_FILE), manyLines);

      const result = (await memoryReadTool.execute(
        {},
        makeCtx(),
      )) as string;

      const indexSection = result.slice(
        result.indexOf("## Memory Index"),
        result.indexOf(MEMORY_CONTEXT_END),
      );
      const lineCount = indexSection.split("\n").filter((l) => l.startsWith("- [")).length;
      expect(lineCount).toBe(DEFAULT_MAX_INDEX_LINES);
      expect(result).toContain(INDEX_TRUNCATION_SUFFIX.trim());
    });

    test("truncates preferences when exceeding max bytes", async () => {
      const largePref = "x".repeat(DEFAULT_MAX_PREFERENCES_BYTES + 1000);
      await Bun.write(join(userDir, PREFERENCES_FILE), largePref);

      const result = (await memoryReadTool.execute(
        {},
        makeCtx(),
      )) as string;

      const prefsIndex = result.indexOf(PREFERENCES_MARKER_START);
      const prefsEnd = result.indexOf(PREFERENCES_MARKER_END);
      const prefsContent = result.slice(
        prefsIndex + PREFERENCES_MARKER_START.length,
        prefsEnd,
      ).trim();

      expect(new TextEncoder().encode(prefsContent).length).toBeLessThanOrEqual(
        DEFAULT_MAX_PREFERENCES_BYTES,
      );
    });
  });

  describe('name="preferences"', () => {
    test("returns user preferences content", async () => {
      await Bun.write(join(userDir, PREFERENCES_FILE), "I prefer dark mode.");

      const result = (await memoryReadTool.execute(
        { name: "preferences" },
        makeCtx(),
      )) as string;

      expect(result).toBe("I prefer dark mode.");
    });

    test("returns not-found when preferences file missing", async () => {
      const result = (await memoryReadTool.execute(
        { name: "preferences" },
        makeCtx(),
      )) as ToolExecutionResult;

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
      expect(result.output).toContain("Memory preferences not found");
    });
  });

  describe('name="index"', () => {
    test("returns index content", async () => {
      await Bun.write(join(projectDir, INDEX_FILE), "- [Test](test_memory) — Test summary\n");

      const result = (await memoryReadTool.execute(
        { name: "index" },
        makeCtx(),
      )) as string;

      expect(result).toContain("- [Test](test_memory) — Test summary");
    });

    test("returns not-found when index file missing", async () => {
      const result = (await memoryReadTool.execute(
        { name: "index" },
        makeCtx(),
      )) as ToolExecutionResult;

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
      expect(result.output).toContain("Memory index not found");
    });
  });

  describe("name to knowledge topic file", () => {
    test("reads topic file with frontmatter", async () => {
      const topicContent = `---
name: React Patterns
description: Common React patterns and best practices
type: reference
---
React hooks are powerful.`;
      await Bun.write(join(knowledgeDir, "react_patterns.md"), topicContent);

      const result = (await memoryReadTool.execute(
        { name: "react_patterns" },
        makeCtx(),
      )) as string;

      expect(result).toContain(MEMORY_CONTEXT_START);
      expect(result).toContain(MEMORY_CONTEXT_END);
      expect(result).toContain("name: React Patterns");
      expect(result).toContain("description: Common React patterns and best practices");
      expect(result).toContain("type: reference");
      expect(result).toContain("React hooks are powerful.");
    });

    test("returns not-found for missing topic file", async () => {
      const result = (await memoryReadTool.execute(
        { name: "nonexistent" },
        makeCtx(),
      )) as ToolExecutionResult;

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
      expect(result.output).toContain("Memory file not found");
      expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    });

    test("returns error for topic file without frontmatter", async () => {
      await Bun.write(join(knowledgeDir, "raw.md"), "Just raw content\nno frontmatter here.");

      const result = (await memoryReadTool.execute(
        { name: "raw" },
        makeCtx(),
      )) as ToolExecutionResult;

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("execution");
    });

    test("rejects name with invalid characters", async () => {
      const result = (await memoryReadTool.execute(
        { name: "path/traversal" },
        makeCtx(),
      )) as ToolExecutionResult;

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Invalid memory name");
    });
  });

  describe("input schema validation", () => {
    test("accepts valid input with optional name", () => {
      expect(memoryReadTool.inputSchema.safeParse({}).success).toBe(true);
      expect(memoryReadTool.inputSchema.safeParse({ name: "test_memory" }).success).toBe(true);
    });

    test("rejects unknown properties including scope", () => {
      expect(memoryReadTool.inputSchema.safeParse({ scope: "project" }).success).toBe(false);
      expect(memoryReadTool.inputSchema.safeParse({ extra: true }).success).toBe(false);
    });

    test("accepts any string name (validation happens at execution time)", () => {
      expect(memoryReadTool.inputSchema.safeParse({ name: "valid_name" }).success).toBe(true);
    });
  });

  describe("tool metadata", () => {
    test("has correct name and traits", () => {
      expect(memoryReadTool.name).toBe("memory_read");
      expect(memoryReadTool.traits).toEqual({
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      });
    });

    test("has no permissions or hooks", () => {
      expect(memoryReadTool.permissions).toBeUndefined();
      expect(memoryReadTool.hooks).toBeUndefined();
    });
  });
});
