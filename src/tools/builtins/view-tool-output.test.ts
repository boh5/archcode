import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, symlink } from "node:fs/promises";
import { randomUUID } from "crypto";
import { createSessionStore } from "../../store/store";
import { TOOL_OUTPUT_DIR } from "../persist-output";
import type { ToolExecutionContext } from "../types";
import type { CompletedToolPart, ErrorToolPart, ToolPart, StoredPart } from "../../store/types";
import { executeViewToolOutput } from "./view-tool-output";
import { createTestProjectContext } from "../test-project-context";

const TEST_SESSION = `view-test-${randomUUID()}`;
const TEST_DIR = join(TOOL_OUTPUT_DIR, TEST_SESSION);
const TEST_FILE_PATH = join(TEST_DIR, "file_read-test-call-full.txt");
const TEST_FILE_CONTENT = "full output content on disk";

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await Bun.write(TEST_FILE_PATH, TEST_FILE_CONTENT);
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function makeContext(): ToolExecutionContext {
  const store = createSessionStore(`view-test-run-${randomUUID()}`);
  return {
    store,
    toolName: "view_tool_output",
    toolCallId: "view-call",
    input: { callId: "test-call" },
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["view_tool_output"]),
    workspaceRoot: import.meta.dir,
    projectContext: createTestProjectContext(import.meta.dir),
  };
}

function completeToolPart(
  overrides?: Partial<CompletedToolPart>,
): StoredPart & { state: "completed" } {
  return {
    type: "tool",
    id: "tool-1",
    state: "completed",
    toolCallId: "test-call",
    toolName: "file_read",
    input: {},
    output: "test output content",
    createdAt: 100,
    startedAt: 101,
    endedAt: 102,
    ...overrides,
  };
}

function errorToolPart(
  overrides?: Partial<ErrorToolPart>,
): StoredPart & { state: "error" } {
  return {
    type: "tool",
    id: "tool-err-1",
    state: "error",
    toolCallId: "error-call",
    toolName: "file_read",
    input: {},
    errorMessage: "error message content",
    createdAt: 100,
    startedAt: 101,
    endedAt: 102,
    ...overrides,
  };
}

function setMessages(ctx: ToolExecutionContext, parts: StoredPart[]): void {
  ctx.store.setState({
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        parts,
        createdAt: 100,
      },
    ],
  });
}

describe("view_tool_output tool", () => {
  it("retrieves persisted output from disk via callId", async () => {
    const ctx = makeContext();
    setMessages(ctx, [
      completeToolPart({
        toolCallId: "persisted-call",
        meta: { fullOutputPath: TEST_FILE_PATH },
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "persisted-call" }, ctx);
    expect(result).toBe(TEST_FILE_CONTENT);
  });

  it("retrieves in-memory output when no fullOutputPath", async () => {
    const ctx = makeContext();
    setMessages(ctx, [
      completeToolPart({
        toolCallId: "memory-call",
        output: "in-memory content",
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "memory-call" }, ctx);
    expect(result).toBe("in-memory content");
  });

  it("retrieves error output from in-memory when no fullOutputPath", async () => {
    const ctx = makeContext();
    setMessages(ctx, [
      errorToolPart({
        toolCallId: "error-call",
        errorMessage: "error details",
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "error-call" }, ctx);
    expect(result).toBe("error details");
  });

  it("rejects path traversal (../../etc/passwd)", async () => {
    const ctx = makeContext();
    setMessages(ctx, [
      completeToolPart({
        toolCallId: "traversal-call",
        meta: { fullOutputPath: "../../etc/passwd" },
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "traversal-call" }, ctx);
    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain("Invalid tool output reference");
  });

  it("rejects absolute path outside cache (/etc/passwd)", async () => {
    const ctx = makeContext();
    setMessages(ctx, [
      completeToolPart({
        toolCallId: "absolute-call",
        meta: { fullOutputPath: "/etc/passwd" },
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "absolute-call" }, ctx);
    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain("Invalid tool output reference");
  });

  it("rejects symlink escape", async () => {
    const symlinkPath = join(TEST_DIR, "escape-link.txt");

    try {
      await symlink("/etc/passwd", symlinkPath);

      const ctx = makeContext();
      setMessages(ctx, [
        completeToolPart({
          toolCallId: "symlink-call",
          meta: { fullOutputPath: symlinkPath },
        }),
      ]);

      const result = await executeViewToolOutput({ callId: "symlink-call" }, ctx);
      expect(typeof result).toBe("object");
      expect((result as { isError: boolean }).isError).toBe(true);
      expect((result as { output: string }).output).toContain("Invalid tool output reference");
    } finally {
      await rm(symlinkPath, { force: true }).catch(() => {});
    }
  });

  it("returns not-found error for evicted file", async () => {
    const ctx = makeContext();
    const nonExistentPath = join(TEST_DIR, "non-existent.txt");
    setMessages(ctx, [
      completeToolPart({
        toolCallId: "evicted-call",
        meta: { fullOutputPath: nonExistentPath },
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "evicted-call" }, ctx);
    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain(
      "Tool output has been evicted from cache",
    );
  });

  it("returns not-found error for nonexistent callId", async () => {
    const ctx = makeContext();
    const result = await executeViewToolOutput({ callId: "nonexistent" }, ctx);
    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain("Tool call not found");
  });

  it("returns error for pending tool call", async () => {
    const ctx = makeContext();
    const pendingPart: ToolPart = {
      type: "tool",
      id: "tool-pending-1",
      state: "pending",
      toolCallId: "pending-call",
      toolName: "file_read",
      createdAt: 100,
    };
    setMessages(ctx, [pendingPart]);

    const result = await executeViewToolOutput({ callId: "pending-call" }, ctx);
    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain("not completed yet");
  });

  it("rejects path pointing to parent directory traversal", async () => {
    const ctx = makeContext();
    setMessages(ctx, [
      completeToolPart({
        toolCallId: "parent-call",
        meta: { fullOutputPath: join(TEST_DIR, "..", "..", "etc", "passwd") },
      }),
    ]);

    const result = await executeViewToolOutput({ callId: "parent-call" }, ctx);
    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain("Invalid tool output reference");
  });
});
