import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { StoreApi } from "zustand";
import { createSessionStore } from "./store";
import type { SessionStoreState, StoredMessage } from "./types";

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
});

const ToolPartSchema = z.discriminatedUnion("state", [
  PendingToolPartSchema,
  RunningToolPartSchema,
  CompletedToolPartSchema,
  ErrorToolPartSchema,
]);

const StoredPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
]);

const StoredMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(StoredPartSchema),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  runId: z.string().optional(),
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
  messages: z.array(StoredMessageSchema),
  steps: z.array(StepInfoSchema).optional(),
});

export type SessionFile = z.infer<typeof SessionFileSchema>;

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
  state: Pick<SessionStoreState, "sessionId" | "createdAt" | "messages" | "steps">,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const data: SessionFile = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    messages: state.messages,
    steps: state.steps,
  };

  const json = JSON.stringify(data, null, 2);
  const finalPath = join(dir, `${state.sessionId}.json`);
  const tmpPath = join(dir, `${state.sessionId}.json.tmp`);

  await writeFile(tmpPath, json, "utf-8");
  await rename(tmpPath, finalPath);
}

export async function loadSessionTranscript(
  sessionId: string,
  dir: string,
): Promise<StoreApi<SessionStoreState>> {
  const filePath = join(dir, `${sessionId}.json`);
  const raw = await readFile(filePath, "utf-8");
  const parsed = SessionFileSchema.parse(JSON.parse(raw));

  if (parsed.sessionId !== sessionId) {
    throw new Error(
      `Session ID mismatch: expected "${sessionId}", found "${parsed.sessionId}" in file`,
    );
  }

  const store = createSessionStore(sessionId);
  store.setState({
    sessionId: parsed.sessionId,
    createdAt: parsed.createdAt,
    messages: parsed.messages,
    steps: parsed.steps ?? [],
    isRunning: false,
    isStreamingModel: false,
    currentRunId: undefined,
    currentAssistantMessageId: undefined,
    streamingText: undefined,
    streamingReasoning: undefined,
    streamingTools: {},
  });

  return store;
}
