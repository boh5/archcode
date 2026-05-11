import { describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand";
import type { ModelInfo } from "../../../provider/model";
import { createMockStore } from "../../../store/test-helpers";
import type { SessionStoreState, StepInfo, StoredPart, StoredTodo } from "../../../store/types";
import type { AfterStepEndContext } from "../loop-hooks";
import { createTodoContinuationHook } from "./todo-continuation";

describe("createTodoContinuationHook", () => {
  test("injects reminder when stagnant after 3+ consecutive identical todo hashes", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const hook = createTodoContinuationHook();

    await runStep(hook, store, "tool-calls");
    await runStep(hook, store, "tool-calls");
    await runStep(hook, store, "tool-calls");
    expect(store.getState().reminders).toHaveLength(0);

    await runStep(hook, store, "tool-calls");

    expect(store.getState().reminders).toHaveLength(1);
    expect(store.getState().reminders[0]?.source).toMatchObject({
      type: "todo_continuation",
      pendingTodos: [{ id: "todo-1", content: "continue", status: "pending" }],
    });
  });

  test("injects reminder at loop end when pending todos exist", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "finish", status: "in_progress" }]);
    const hook = createTodoContinuationHook();

    await runStep(hook, store, "stop");

    expect(store.getState().reminders).toHaveLength(1);
    expect(store.getState().reminders[0]?.content).toContain("finish");
  });

  test("respects cooldown between injections", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const hook = createTodoContinuationHook();

    await runStep(hook, store, "stop");
    await runStep(hook, store, "length");

    expect(store.getState().reminders).toHaveLength(1);
  });

  test("respects max count of 10 continuations", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const hook = createTodoContinuationHook();

    for (let index = 0; index < 12; index += 1) {
      await runStep(hook, store, "stop");
      consumeReminderCooldown(store);
    }

    expect(store.getState().reminders).toHaveLength(10);
  });

  test("does not inject when no pending todos", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "done", status: "completed" }]);
    const hook = createTodoContinuationHook();

    await runStep(hook, store, "stop");

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("does not inject when pending question exists", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    seedAssistantTool(store, "ask_user");
    const hook = createTodoContinuationHook();

    await runStep(hook, store, "stop");

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("does not inject when sub-agents are running", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const hook = createTodoContinuationHook({ subAgentManager: { activeCount: 1 } });

    await runStep(hook, store, "stop");

    expect(store.getState().reminders).toHaveLength(0);
  });

  test("resets closure state for each factory instance", async () => {
    const store = createHookStore();
    seedTodos(store, [{ id: "todo-1", content: "continue", status: "pending" }]);
    const firstHook = createTodoContinuationHook();

    await runStep(firstHook, store, "tool-calls");
    await runStep(firstHook, store, "tool-calls");
    await runStep(firstHook, store, "tool-calls");

    const secondHook = createTodoContinuationHook();
    await runStep(secondHook, store, "tool-calls");

    expect(store.getState().reminders).toHaveLength(0);
  });
});

type TodoContinuationHook = (ctx: AfterStepEndContext) => Promise<void>;

function createHookStore(): StoreApi<SessionStoreState> {
  return createMockStore();
}

async function runStep(
  hook: TodoContinuationHook,
  store: StoreApi<SessionStoreState>,
  finishReason: string,
): Promise<void> {
  const stepIndex = store.getState().steps.length;
  store.setState((state) => ({
    steps: [...state.steps, stepInfo(stepIndex, finishReason)],
  }));

  await hook({ store, modelInfo: modelInfoStub() });
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
      reminder.source.type === "todo_continuation"
        ? { ...reminder, source: { ...reminder.source, type: "subagent_completed", sessionId: reminder.id } }
        : reminder,
    ),
  }));
}

function stepInfo(step: number, finishReason: string): StepInfo {
  return {
    id: `step-${step}`,
    step,
    startedAt: step,
    completedAt: step + 1,
    finishReason,
  };
}

function modelInfoStub(): ModelInfo {
  return {} as ModelInfo;
}
