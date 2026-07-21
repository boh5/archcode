import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StoreApi } from "zustand";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { inferToolErrorKindFromResult } from "../errors";
import type { RawToolResult, RegistryExecutionOutcome, ToolExecutionContext } from "../types";
import { createTestToolRegistryFixture } from "../test-registry";
import { todoWriteTool, TodoWriteInputSchema } from "./todo-write";
import { createTestProjectContext } from "../test-project-context";

const testDir = join(tmpdir(), "archcode-todo-write", crypto.randomUUID());
const registryFixture = createTestToolRegistryFixture({ descriptors: [todoWriteTool] });

afterAll(async () => {
  await registryFixture.dispose();
  await rm(testDir, { recursive: true, force: true });
});

function rawText(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error("Expected text draft");
  return result.draft.text;
}

function settled(outcome: RegistryExecutionOutcome) {
  if (outcome.kind !== "settled") throw new Error("Expected settled Registry outcome");
  return outcome.result;
}

function makeStore(): StoreApi<SessionStoreState> {
  return storeManager.create(`todo-test-${crypto.randomUUID()}`, testDir, { agentName: "lead" });
}

function makeCtx(store: StoreApi<SessionStoreState>): ToolExecutionContext {
  return {
    store,
    storeManager,
    toolName: "todo_write",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["todo_write"]),
    cwd: testDir,
    projectContext: createTestProjectContext(testDir),
  };
}

describe("TodoWriteInputSchema", () => {
  test("accepts valid input", () => {
    const result = TodoWriteInputSchema.safeParse({
      todos: [
        { id: "todo-1", content: "first", status: "pending" },
        { content: "second", status: "in_progress" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown top-level fields", () => {
    const result = TodoWriteInputSchema.safeParse({
      todos: [],
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown fields on todo items", () => {
    const result = TodoWriteInputSchema.safeParse({
      todos: [{ content: "test", status: "pending", extra: true }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid status", () => {
    const result = TodoWriteInputSchema.safeParse({
      todos: [{ content: "test", status: "blocked" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing content", () => {
    const result = TodoWriteInputSchema.safeParse({
      todos: [{ status: "pending" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("todoWriteTool", () => {
  test("first call stores ordered todos", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    const output = await todoWriteTool.execute(
      {
        todos: [
          { content: "first", status: "pending" },
          { content: "second", status: "in_progress" },
          { content: "third", status: "completed" },
        ],
      },
      ctx,
    );

    const todos = store.getState().todos;
    expect(todos).toHaveLength(3);
    expect(todos[0]?.id).toBe("todo-1");
    expect(todos[0]?.content).toBe("first");
    expect(todos[0]?.status).toBe("pending");
    expect(todos[1]?.id).toBe("todo-2");
    expect(todos[1]?.content).toBe("second");
    expect(todos[1]?.status).toBe("in_progress");
    expect(todos[2]?.id).toBe("todo-3");
    expect(todos[2]?.content).toBe("third");
    expect(todos[2]?.status).toBe("completed");
    expect(rawText(output)).toContain("Todos updated");
    expect(rawText(output)).toContain("1 pending");
    expect(rawText(output)).toContain("1 in_progress");
    expect(rawText(output)).toContain("1 completed");
  });

  test("second call replaces full list", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    await todoWriteTool.execute(
      { todos: [{ id: "a", content: "keep me?", status: "pending" }] },
      ctx,
    );

    const afterFirst = store.getState().todos;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.content).toBe("keep me?");

    await todoWriteTool.execute(
      { todos: [{ id: "b", content: "replacement", status: "completed" }] },
      ctx,
    );

    const afterSecond = store.getState().todos;
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.id).toBe("b");
    expect(afterSecond[0]?.content).toBe("replacement");
  });

  test("more than one in_progress returns isError and leaves previous todos unchanged", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);
    const registry = registryFixture.registry;

    const prevResult = await registry.execute(
      {
        toolCallId: "call-prev",
        toolName: "todo_write",
        input: { todos: [{ content: "previous", status: "completed" }] },
      },
      ctx,
    );
    expect(settled(prevResult).isError).toBe(false);

    const before = store.getState().todos;

    const result = await registry.execute(
      {
        toolCallId: "call-1",
        toolName: "todo_write",
        input: {
          todos: [
            { content: "one", status: "in_progress" },
            { content: "two", status: "in_progress" },
          ],
        },
      },
      ctx,
    );

    const finalized = settled(result);
    expect(finalized.isError).toBe(true);
    expect(finalized.details?.error?.kind).toBe("todo-validation");
    expect(finalized.output.preview).toContain("Only one todo");

    const after = store.getState().todos;
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe("previous");
  });

  test("duplicate IDs are rejected and leave previous todos unchanged", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    await todoWriteTool.execute(
      { todos: [{ id: "existing", content: "previous", status: "pending" }] },
      ctx,
    );

    const before = store.getState().todos;

    const result = (await todoWriteTool.execute(
      {
        todos: [
          { id: "dup", content: "first", status: "pending" },
          { id: "dup", content: "second", status: "pending" },
        ],
      },
      ctx,
    ));
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("todo-validation");
    expect(result.details?.error).toBeDefined();
    expect(rawText(result)).toContain("Duplicate todo IDs");

    const after = store.getState().todos;
    expect(after).toEqual(before);
  });

  test("deterministic ID generation", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    await todoWriteTool.execute(
      {
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "completed" },
        ],
      },
      ctx,
    );

    const todos = store.getState().todos;
    expect(todos[0]?.id).toBe("todo-1");
    expect(todos[1]?.id).toBe("todo-2");
    expect(todos[2]?.id).toBe("todo-3");
  });

  test("output summary without in_progress item", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    const output = await todoWriteTool.execute(
      {
        todos: [
          { content: "done", status: "completed" },
          { content: "dropped", status: "cancelled" },
        ],
      },
      ctx,
    );

    expect(rawText(output)).toBe(
      "Todos updated — 0 pending, 0 in_progress, 1 completed, 1 cancelled",
    );
  });

  test("output summary with in_progress item shows current task", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    const output = await todoWriteTool.execute(
      {
        todos: [
          { content: "active task", status: "in_progress" },
          { content: "backlog", status: "pending" },
        ],
      },
      ctx,
    );

    expect(rawText(output)).toContain(
      "Todos updated — 1 pending, 1 in_progress, 0 completed, 0 cancelled",
    );
    expect(rawText(output)).toContain('Current: "active task"');
  });

  test("output summary with all statuses", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);

    const output = await todoWriteTool.execute(
      {
        todos: [
          { content: "p1", status: "pending" },
          { content: "inp", status: "in_progress" },
          { content: "c1", status: "completed" },
          { content: "c2", status: "completed" },
          { content: "x1", status: "cancelled" },
        ],
      },
      ctx,
    );

    expect(rawText(output)).toContain("1 pending");
    expect(rawText(output)).toContain("1 in_progress");
    expect(rawText(output)).toContain("2 completed");
    expect(rawText(output)).toContain("1 cancelled");
    expect(rawText(output)).toContain('Current: "inp"');
  });
});

describe("todoWriteTool via registry", () => {
  test("schema validation via registry returns isError for unknown fields", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);
    const registry = registryFixture.registry;

    const result = await registry.execute(
      {
        toolCallId: "call-1",
        toolName: "todo_write",
        input: { todos: [], extra: true },
      },
      ctx,
    );

    expect(settled(result).isError).toBe(true);
    expect(settled(result).output.preview).toContain("Unrecognized key");
  });

  test("schema validation via registry returns isError for invalid status", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);
    const registry = registryFixture.registry;

    const result = await registry.execute(
      {
        toolCallId: "call-1",
        toolName: "todo_write",
        input: { todos: [{ content: "bad", status: "blocked" }] },
      },
      ctx,
    );

    expect(settled(result).isError).toBe(true);
    expect(settled(result).output.preview).toContain("Invalid option");
  });
});

describe("no workspace side effects", () => {
  test("no workspace files are created or modified", async () => {
    const store = makeStore();
    const ctx = makeCtx(store);
    await mkdir(testDir, { recursive: true });

    await todoWriteTool.execute(
      { todos: [{ content: "no file side effect", status: "pending" }] },
      ctx,
    );
    await todoWriteTool.execute(
      { todos: [{ content: "second call", status: "completed" }] },
      ctx,
    );
    await todoWriteTool.execute(
      { todos: [{ content: "third call", status: "in_progress" }] },
      ctx,
    );

    const entries = await readdir(testDir);
    expect(entries).toEqual([]);

    await rm(testDir, { recursive: true, force: true });
  });
});
