import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryReadTool } from "./memory-read";
import { MemoryFileManager, MemoryPathError } from "../../memory";
import { MemoryService } from "../../memory/service";
import { storeManager } from "../../store/store";
import type { ProjectContext } from "../../projects/types";
import {
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_FILE,
  KNOWLEDGE_DIR_NAME,
  MAX_MEMORY_TOPICS,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  PREFERENCES_FILE,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
} from "../../memory/constants";
import { inferToolErrorKindFromResult } from "../errors";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { ONE_SHOT_FILE_READ_MAX_BYTES } from "../../utils/safe-file";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), "archcode-memory-read", crypto.randomUUID());
const projectDir = join(testDir, "project");
const userDir = join(testDir, "user");
const knowledgeDir = join(projectDir, KNOWLEDGE_DIR_NAME);

let fileManager: MemoryFileManager;
let memoryService: MemoryService;
let memoryReadTool: ReturnType<typeof createMemoryReadTool>;
const testSkillService = new SkillService({ builtinSkills: {} });

beforeAll(async () => {
  await mkdir(projectDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  fileManager = new MemoryFileManager({ project: projectDir, user: userDir });
  memoryService = new MemoryService(fileManager);
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
  const projectContext: ProjectContext = overrides.projectContext ?? {
    ...createTestProjectContext(workspaceRoot),
    project: { slug: "memory-read", name: "Memory Read", workspaceRoot, addedAt: new Date().toISOString() },
    memory: memoryService,
  };
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "memory_read",
  toolCallId: "call-1",
  input: {},
  step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["memory_read"]),
  agentSkills: [],
  skillService: testSkillService,
  projectContext,
  ...overrides,
  cwd: overrides.cwd ?? workspaceRoot, });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMemoryReadTool", () => {
  describe("no-arg call (combined context)", () => {
    test("returns combined context with user preferences and index in correct order", async () => {
      await Bun.write(join(projectDir, INDEX_FILE), "- [Alpha](alpha) — First topic\n");
      await Bun.write(join(userDir, PREFERENCES_FILE), "User likes simplicity.");

      const result = expectTextDraft(await memoryReadTool.execute(
        {},
        makeCtx(),
      ));

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
      const result = expectTextDraft(await memoryReadTool.execute(
        {},
        makeCtx(),
      ));

      expect(result).toBe(`${MEMORY_CONTEXT_START}\n\n${MEMORY_CONTEXT_END}`);
    });

    test("does not read or parse topic documents", async () => {
      await Bun.write(join(projectDir, INDEX_FILE), "- [Opaque](opaque) — Indexed metadata\n");
      await Bun.write(
        join(knowledgeDir, "opaque.md"),
        "This body is deliberately not a valid topic document.",
      );

      const result = expectTextDraft(await memoryReadTool.execute({}, makeCtx()));

      expect(result).toContain("- [Opaque](opaque) — Indexed metadata");
      expect(result).not.toContain("deliberately not a valid topic document");
    });

    test("omits the complete index when the project exceeds the topic limit", async () => {
      const manyLines = createIndexEntries(MAX_MEMORY_TOPICS + 1);
      await Bun.write(join(projectDir, INDEX_FILE), manyLines);
      await Promise.all(Array.from({ length: MAX_MEMORY_TOPICS + 1 }, (_, index) => (
        Bun.write(
          join(knowledgeDir, `topic_${index}.md`),
          `---\nname: Topic ${index}\ndescription: Summary ${index}\ntype: project\n---\nBody`,
        )
      )));

      const result = expectTextDraft(await memoryReadTool.execute(
        {},
        makeCtx(),
      ));

      expect(result).not.toContain("## Memory Index");
      expect(result).not.toContain("- [Topic 0]");
      expect(result).toContain("Project Memory index is over capacity and omitted");
    });

    test("omits over-capacity preferences instead of truncating them", async () => {
      const largePref = "x".repeat(DEFAULT_MAX_PREFERENCES_BYTES + 1000);
      await Bun.write(join(userDir, PREFERENCES_FILE), largePref);

      const result = expectTextDraft(await memoryReadTool.execute(
        {},
        makeCtx(),
      ));

      expect(result).not.toContain(PREFERENCES_MARKER_START);
      expect(result).not.toContain("x".repeat(100));
      expect(result).toContain("Personal Memory is over capacity and omitted");
    });
  });

  describe('name="preferences"', () => {
    test("returns user preferences content", async () => {
      await Bun.write(join(userDir, PREFERENCES_FILE), "I prefer dark mode.");

      const result = expectTextDraft(await memoryReadTool.execute(
        { name: "preferences" },
        makeCtx(),
      ));

      expect(result).toBe("I prefer dark mode.");
    });

    test("returns not-found when preferences file missing", async () => {
      const result = (await memoryReadTool.execute(
        { name: "preferences" },
        makeCtx(),
      ));

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
      expect(expectTextDraft(result)).toContain("Memory preferences not found");
    });

    test("rejects one byte over the one-shot file cap without partial fallback", async () => {
      await Bun.write(join(userDir, PREFERENCES_FILE), "x".repeat(ONE_SHOT_FILE_READ_MAX_BYTES + 1));

      const result = await memoryReadTool.execute({ name: "preferences" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.details?.error?.code).toBe("TOOL_OUTPUT_POLICY_VIOLATION");
      expect(expectTextDraft(result)).not.toContain("x".repeat(1_024));
    });
  });

  describe('name="index"', () => {
    test("returns index content", async () => {
      await Bun.write(join(projectDir, INDEX_FILE), "- [Test](test_memory) — Test summary\n");

      const result = expectTextDraft(await memoryReadTool.execute(
        { name: "index" },
        makeCtx(),
      ));

      expect(result).toContain("- [Test](test_memory) — Test summary");
    });

    test("returns not-found when index file missing", async () => {
      const result = (await memoryReadTool.execute(
        { name: "index" },
        makeCtx(),
      ));

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
      expect(expectTextDraft(result)).toContain("Memory index not found");
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

      const result = expectTextDraft(await memoryReadTool.execute(
        { name: "react_patterns" },
        makeCtx(),
      ));

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
      ));

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
      expect(expectTextDraft(result)).toContain("Memory file not found");
      expect(result.details?.error).toBeDefined();
    });

    test("returns error for topic file without frontmatter", async () => {
      await Bun.write(join(knowledgeDir, "raw.md"), "Just raw content\nno frontmatter here.");

      const result = (await memoryReadTool.execute(
        { name: "raw" },
        makeCtx(),
      ));

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("execution");
    });

    test("rejects name with invalid characters", async () => {
      const result = (await memoryReadTool.execute(
        { name: "path/traversal" },
        makeCtx(),
      ));

      expect(result.isError).toBe(true);
      expect(expectTextDraft(result)).toContain("Invalid memory name");
    });

    test("redacts path and secret sentinels from Memory path and filesystem failures", async () => {
      const secret = "sk_test_memory_read_secret_1234567890";
      const privatePath = `/private/sensitive/${secret}/topic.md`;
      const readTopic = memoryService.readTopic.bind(memoryService);
      const readPromptManifest = memoryService.readPromptManifest.bind(memoryService);

      try {
        memoryService.readTopic = async () => {
          throw new MemoryPathError(privatePath, `escaped root with ${secret}`);
        };
        const pathResult = await memoryReadTool.execute({ name: "safe_topic" }, makeCtx());
        expect(pathResult.isError).toBe(true);
        expect(pathResult.details?.error?.code).toBe("TOOL_FILE_OUTSIDE_WORKSPACE");
        expect(expectTextDraft(pathResult)).toContain("Memory path is outside the configured Memory roots");
        expect(JSON.stringify(pathResult)).not.toContain(privatePath);
        expect(JSON.stringify(pathResult)).not.toContain(secret);

        memoryService.readPromptManifest = async () => {
          throw new Error(`EACCES ${privatePath} ${secret}`);
        };
        const ioResult = await memoryReadTool.execute({}, makeCtx());
        expect(ioResult.isError).toBe(true);
        expect(ioResult.details?.error?.code).toBe("TOOL_MEMORY_READ_FAILED");
        expect(expectTextDraft(ioResult)).toContain("Memory could not be read");
        expect(JSON.stringify(ioResult)).not.toContain(privatePath);
        expect(JSON.stringify(ioResult)).not.toContain(secret);
      } finally {
        memoryService.readTopic = readTopic;
        memoryService.readPromptManifest = readPromptManifest;
      }
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
