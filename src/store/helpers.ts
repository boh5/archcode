import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { StoreApi } from "zustand";
import { createSessionStore } from "./store";
import type { SessionStoreState, StoredMessage } from "./types";
import { getSessionsDir } from "./sessions-dir";

const StoredTodoSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const ReminderSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("todo_step_reminder"),
    pendingTodos: z.array(StoredTodoSchema),
  }),
  z.strictObject({
    type: z.literal("todo_loop_continuation"),
    pendingTodos: z.array(StoredTodoSchema),
  }),
  z.strictObject({
    type: z.literal("subagent_completed"),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal("subagent_failed"),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal("subagent_timed_out"),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal("subagent_cancelled"),
    sessionId: z.string(),
  }),
]);

const ReminderSchema = z.strictObject({
  id: z.string(),
  source: ReminderSourceSchema,
  delivery: z.enum(["auto_inject", "on_demand"]),
  sessionId: z.string().optional(),
  terminalState: z.string().optional(),
  content: z.string(),
  payload: z.unknown().optional(),
  createdAt: z.number(),
  consumedAt: z.number().nullable(),
  targetSessionId: z.string().optional(),
});

const TextPartSchema = z.strictObject({
  type: z.literal("text"),
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

const ReasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

const PendingToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("pending"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  createdAt: z.number(),
});

const RunningToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("running"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  createdAt: z.number(),
  startedAt: z.number(),
});

const CompletedToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("completed"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  output: z.string(),
  createdAt: z.number(),
  startedAt: z.number(),
  endedAt: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const ErrorToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("error"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  errorMessage: z.string(),
  createdAt: z.number(),
  startedAt: z.number(),
  endedAt: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const ToolPartSchema = z.discriminatedUnion("state", [
  PendingToolPartSchema,
  RunningToolPartSchema,
  CompletedToolPartSchema,
  ErrorToolPartSchema,
]);

const CompactionPartSchema = z.strictObject({
  type: z.literal("compaction"),
  id: z.string(),
  summary: z.string(),
  tailStartId: z.string(),
  compactedAt: z.number(),
});

const SystemNoticePartSchema = z.strictObject({
  type: z.literal("system-notice"),
  id: z.string(),
  notice: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

const StoredPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  CompactionPartSchema,
  SystemNoticePartSchema,
]);

const StoredMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(StoredPartSchema),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  runId: z.string().optional(),
  compacted: z.boolean().optional(),
});

const StepInfoSchema = z.strictObject({
  id: z.string(),
  step: z.number(),
  runId: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  finishReason: z.string().optional(),
  usage: z.unknown().optional(),
  error: z.string().optional(),
});

const SessionFileSchema = z.strictObject({
  sessionId: z.string(),
  createdAt: z.number(),
  title: z.string().nullable().optional(),
  messages: z.array(StoredMessageSchema),
  steps: z.array(StepInfoSchema).optional(),
  todos: z.array(StoredTodoSchema)
    .refine(
      (todos) => todos.filter((todo) => todo.status === "in_progress").length <= 1,
      "Only one todo can be in_progress",
    )
    .optional(),
  reminders: z.array(ReminderSchema).default([]),
  childSessionIds: z.array(z.string()).default([]),
  parentSessionId: z.string().optional(),
  subAgentDescriptions: z.array(z.tuple([z.string(), z.string()])).default([]),
});

export type SessionFile = z.infer<typeof SessionFileSchema>;

type PersistableSessionState = Pick<
  SessionStoreState,
  "sessionId" | "createdAt" | "title" | "messages" | "steps" | "todos"
> & Partial<Pick<
  SessionStoreState,
  "reminders" | "childSessionIds" | "parentSessionId" | "subAgentDescriptions"
>>;

export function getAssistantText(messages: StoredMessage[]): string {
  let text = "";

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) {
      if (part.type === "text" && part.completedAt !== undefined) {
        text += part.text;
      }
    }
  }

  return text;
}

export async function saveSessionTranscript(
  state: PersistableSessionState,
  workspaceRoot: string,
): Promise<void> {
  const dir = getSessionsDir(workspaceRoot);

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create sessions directory "${dir}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const data: SessionFile = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    title: state.title ?? null,
    messages: state.messages,
    steps: state.steps,
    todos: state.todos,
    reminders: state.reminders ?? [],
    childSessionIds: Array.from(state.childSessionIds ?? []),
    subAgentDescriptions: Array.from(state.subAgentDescriptions ?? []),
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
  };

  const json = JSON.stringify(data, null, 2);
  const finalPath = join(dir, `${state.sessionId}.json`);
  const tmpPath = join(dir, `${state.sessionId}.json.tmp`);

  try {
    await Bun.write(tmpPath, json);
  } catch (err) {
    throw new Error(`Failed to write session transcript to "${tmpPath}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    throw new Error(`Failed to rename session transcript from "${tmpPath}" to "${finalPath}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export async function loadSessionTranscript(
  sessionId: string,
  workspaceRoot: string,
): Promise<StoreApi<SessionStoreState>> {
  const dir = getSessionsDir(workspaceRoot);
  const filePath = join(dir, `${sessionId}.json`);
  const raw = await Bun.file(filePath).text();
  const parsed = SessionFileSchema.parse(JSON.parse(raw));

  if (parsed.sessionId !== sessionId) {
    throw new Error(
      `Session ID mismatch: expected "${sessionId}", found "${parsed.sessionId}" in file`,
    );
  }

  const store = createSessionStore(sessionId, workspaceRoot);
  store.setState({
    sessionId: parsed.sessionId,
    createdAt: parsed.createdAt,
    title: parsed.title ?? null,
    messages: parsed.messages,
    steps: parsed.steps ?? [],
    todos: parsed.todos ?? [],
    reminders: parsed.reminders,
    childSessionIds: new Set(parsed.childSessionIds),
    parentSessionId: parsed.parentSessionId,
    subAgentDescriptions: new Map(parsed.subAgentDescriptions),
    isRunning: false,
    isStreamingModel: false,
    currentRunId: undefined,
    currentAssistantMessageId: undefined,
    streamingText: undefined,
    streamingReasoning: undefined,
    streamingTools: {},
    readSnapshots: new Map(),
  });

  return store;
}
