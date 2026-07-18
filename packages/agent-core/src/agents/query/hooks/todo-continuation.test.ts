import { describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand";
import { createMockStore } from "../../../store/test-helpers";
import type { SessionStoreState, StepInfo, StoredPart, StoredTodo, ExecutionEndEvent } from "../../../store/types";
import { createTestProjectContext } from "../../../tools/test-project-context";
import type { AfterStepEndContext, AfterLoopEndContext } from "../loop-hooks";
import { silentLogger } from "../../../logger";
import { createTodoContinuationHook } from "./todo-continuation";

describe("createTodoContinuationHook - afterStepEnd (10-step reminder)", () => {
  test("does not inject before 10 steps since last todo_write", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const { afterStepEnd } = createTodoContinuationHook();

    for (let i = 0; i < 9; i++) {
      await runStep(afterStepEnd, store);
    }

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("injects reminder at 10 steps since last todo_write", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const { afterStepEnd } = createTodoContinuationHook();

    for (let i = 0; i < 10; i++) {
      await runStep(afterStepEnd, store);
    }

    expect(store.getState().reminders).toHaveLength(1);
    expect(store.getState().reminders[0]?.content).toContain("TODO REMINDER");
  });

  test("does not inject when no pending todos", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "done", status: "completed" }]);
    store.setState({ lastTodoWriteStepIndex: null });
    const { afterStepEnd } = createTodoContinuationHook();

    for (let i = 0; i < 12; i++) {
      await runStep(afterStepEnd, store);
    }

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("does not inject when pending question exists", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    seedAssistantTool(store, "ask_user");
    store.setState({ lastTodoWriteStepIndex: null });
    const { afterStepEnd } = createTodoContinuationHook();

    for (let i = 0; i < 12; i++) {
      await runStep(afterStepEnd, store);
    }

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("respects cooldown between injections", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    store.setState({ lastTodoWriteStepIndex: null });
    const { afterStepEnd } = createTodoContinuationHook();

    for (let i = 0; i < 11; i++) {
      await runStep(afterStepEnd, store);
    }

    expect(store.getState().reminders).toHaveLength(1);

    for (let i = 0; i < 10; i++) {
      await runStep(afterStepEnd, store);
    }

    expect(store.getState().reminders).toHaveLength(1);
  });

  test("respects max count of 10 reminders", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const { afterStepEnd } = createTodoContinuationHook();

    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < 11; i++) {
        await runStep(afterStepEnd, store);
      }
      consumeReminderCooldown(store);
    }

    const todoContinuationReminders = store.getState().reminders.filter(
      (r) =>
        r.source.type === "todo_step_reminder" ||
        r.source.type === "todo_loop_continuation" ||
        (r.payload as { pendingTodos?: unknown[] } | undefined)?.pendingTodos,
    );
    expect(todoContinuationReminders).toHaveLength(10);
  });
});

describe("createTodoContinuationHook - afterLoopEnd (loop continuation)", () => {
  test("injects continuation on completed loop with pending todos", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "finish", status: "in_progress" }]);
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "completed");

    expect(store.getState().reminders).toHaveLength(1);
    expect(store.getState().reminders[0]?.content).toContain("TODO CONTINUATION");
  });

  test("does not inject on failed loop", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "failed");

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("does not inject when no pending todos", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "done", status: "completed" }]);
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "completed");

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("updates stagnation count when pending todo count does not decrease", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    store.setState({
      lastTodoContinuationPendingCount: 1,
      todoContinuationStagnationCount: 0,
    });
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "completed");

    expect(store.getState().todoContinuationStagnationCount).toBe(1);
  });

  test("resets stagnation count when pending todo count decreases", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    store.setState({
      lastTodoContinuationPendingCount: 3,
      todoContinuationStagnationCount: 2,
    });
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "completed");

    expect(store.getState().todoContinuationStagnationCount).toBe(0);
  });

  test("blocks continuation when stagnation threshold reached", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    store.setState({
      lastTodoContinuationPendingCount: 1,
      todoContinuationStagnationCount: 2,
    });
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "completed");

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("loop continuation no longer depends on workflow state in Goal-era project contexts", async () => {
    const workspaceRoot = `${import.meta.dir}/__test_tmp__/todo-continuation-hook-${crypto.randomUUID()}`;
    const projectContext = createTestProjectContext(workspaceRoot);
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const { afterLoopEnd } = createTodoContinuationHook();

    await runLoopEnd(afterLoopEnd, store, "completed", projectContext);

    expect(store.getState().reminders).toHaveLength(1);
  });
});

function createHookStore(): StoreApi<SessionStoreState> {
  return createMockStore();
}

async function runStep(
  hook: (ctx: AfterStepEndContext) => Promise<void>,
  store: StoreApi<SessionStoreState>,
): Promise<void> {
  const stepIndex = store.getState().steps.length;
  store.setState((state) => ({
    steps: [...state.steps, stepInfo(stepIndex)],
  }));

  await hook({ store, binding: undefined as never, logger: silentLogger });
}

async function runLoopEnd(
  hook: (ctx: AfterLoopEndContext) => Promise<void>,
  store: StoreApi<SessionStoreState>,
  loopEndStatus: ExecutionEndEvent["status"],
  projectContext?: AfterLoopEndContext["projectContext"],
): Promise<void> {
  await hook({ store, binding: undefined as never, logger: silentLogger, loopEndStatus, projectContext });
}

function seedTodos(store: StoreApi<SessionStoreState>, todos: StoredTodo[]): void {
  store.setState({ todos });
}

function seedAssistantTool(store: StoreApi<SessionStoreState>, toolName: string): void {
  const part: StoredPart = {
    type: "tool",
    id: `part-${toolName}`,
    state: "pending",
    toolCallId: `call-${toolName}`,
    toolName,
    createdAt: 1,
  };

  store.setState({
    messages: [{ id: "assistant-1", role: "assistant", parts: [part], createdAt: 1 }],
  });
}

function consumeReminderCooldown(store: StoreApi<SessionStoreState>): void {
  store.setState((state) => ({
    reminders: state.reminders.map((reminder) =>
      reminder.source.type === "todo_step_reminder" || reminder.source.type === "todo_loop_continuation"
        ? {
            ...reminder,
            source: { ...reminder.source, type: "subagent_completed", sessionId: reminder.id } as import("../../../store/types").ReminderSource,
            createdAt: 0,
          }
        : reminder,
    ),
  }));
}

function stepInfo(step: number): StepInfo {
  return {
    id: `step-${step}`,
    step,
    startedAt: step,
    completedAt: step + 1,
  };
}
