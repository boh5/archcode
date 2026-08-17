import { describe, expect, test } from "bun:test";
import type {
  ProjectSessionInventoryItem,
  Session,
  SessionMessage,
} from "../api/types";
import type { SessionExecutionRecord } from "@archcode/protocol";
import {
  extractProjectTodoResultParts,
  selectProjectTodoResultSession,
} from "./project-todo-result";

function inventory(input: {
  id: string;
  todoId?: string;
  entry?: "discussion" | "work";
  status?: NonNullable<ProjectSessionInventoryItem["latestExecution"]>["status"];
  endedAt?: number;
  updatedAt?: number;
}): ProjectSessionInventoryItem {
  const status = input.status ?? "completed";
  return {
    session: {
      sessionId: input.id,
      rootSessionId: input.id,
      cwd: "/workspace",
      agentName: input.entry === "discussion" ? "discussion" : "lead",
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: input.id,
      source: {
        kind: "todo",
        todoId: input.todoId ?? "todo-1",
        entry: input.entry ?? "work",
      },
      createdAt: 1,
      updatedAt: input.updatedAt ?? 1,
    },
    latestExecution: {
      id: `${input.id}-execution`,
      status,
      startedAt: 1,
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    },
  };
}

function execution(input: {
  id: string;
  status: SessionExecutionRecord["status"];
  endedAt?: number;
  finalOutputStepId?: string;
}): SessionExecutionRecord {
  const base = {
    id: input.id,
    startedAt: 1,
    origin: { type: "user" as const, clientRequestId: `${input.id}-request` },
    maxSteps: 50,
    durationMs: 1,
    runs: [],
    executionSkills: [],
    memoryPolicy: { enabled: false, mode: "disabled" as const },
  };
  if (input.status === "running") return { ...base, status: "running" } as unknown as SessionExecutionRecord;
  if (input.status === "suspended") {
    return {
      ...base,
      status: "suspended",
      suspension: { type: "resume_pending", toolBatchId: "batch", readyAt: 2 },
    } as unknown as SessionExecutionRecord;
  }
  return {
    ...base,
    status: input.status,
    endedAt: input.endedAt ?? 2,
    ...(input.finalOutputStepId === undefined ? {} : { finalOutputStepId: input.finalOutputStepId }),
    terminalSettlement: { key: input.id, goalInstanceId: null },
  } as unknown as SessionExecutionRecord;
}

function assistant(
  stepId: string,
  phase: "commentary" | "final_answer",
  parts: SessionMessage extends infer _ ? Array<{
    text: string;
    meta?: Record<string, unknown>;
  }> : never,
): SessionMessage {
  return {
    id: `${stepId}-message`,
    role: "assistant",
    executionId: "execution",
    runOrdinal: 0,
    stepId,
    outputPhase: phase,
    createdAt: 1,
    completedAt: 2,
    parts: parts.map((part, index) => ({
      type: "assistant-output",
      id: `${stepId}-${index}`,
      blockId: `${stepId}-block-${index}`,
      text: part.text,
      createdAt: 1,
      completedAt: 2,
      ...(part.meta === undefined ? {} : { meta: part.meta }),
    })),
  };
}

describe("Project Todo Result", () => {
  test("selects the latest completed bound Work Session with deterministic tie-breaks", () => {
    const selected = selectProjectTodoResultSession([
      inventory({ id: "discussion-newer", entry: "discussion", endedAt: 99, updatedAt: 99 }),
      inventory({ id: "failed-newer", status: "failed", endedAt: 90, updatedAt: 90 }),
      inventory({ id: "work-z", endedAt: 20, updatedAt: 30 }),
      inventory({ id: "work-b", endedAt: 20, updatedAt: 40 }),
      inventory({ id: "work-a", endedAt: 20, updatedAt: 40 }),
      inventory({ id: "other-todo", todoId: "todo-2", endedAt: 100, updatedAt: 100 }),
    ], "todo-1");

    expect(selected).toEqual({ sessionId: "work-a" });
  });

  test("requires finalOutputStepId and final_answer instead of commentary or tool-only fallback", () => {
    expect(extractProjectTodoResultParts({
      executions: [execution({ id: "completed", status: "completed", endedAt: 5 })],
      messages: [assistant("commentary", "commentary", [{ text: "not a result" }])],
    })).toEqual([]);

    expect(extractProjectTodoResultParts({
      executions: [execution({ id: "completed", status: "completed", endedAt: 5, finalOutputStepId: "final" })],
      messages: [assistant("final", "commentary", [{ text: "still commentary" }])],
    })).toEqual([]);
  });

  test("keeps trusted output blocks in source order and preserves their original text", () => {
    const first = "  First block\n";
    const second = "\nSecond block  ";
    expect(extractProjectTodoResultParts({
      executions: [
        execution({ id: "older", status: "completed", endedAt: 4, finalOutputStepId: "older-step" }),
        execution({ id: "latest", status: "completed", endedAt: 5, finalOutputStepId: "final" }),
      ],
      messages: [
        assistant("older-step", "final_answer", [{ text: "older" }]),
        assistant("final", "final_answer", [
          { text: first },
          { text: "   " },
          { text: "interrupted", meta: { interrupted: true } },
          { text: "discarded", meta: { discardedFromContext: true } },
          { text: second },
        ]),
      ],
    })).toEqual([first, second]);
  });
});
