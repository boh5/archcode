import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { StoreApi } from "zustand";
import type {
  TranscriptEvent,
  SessionTranscriptState,
} from "./types";
import { createSessionStore } from "./store";

export function getAssistantText(events: TranscriptEvent[]): string {
  return events
    .filter((e): e is Extract<TranscriptEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.text)
    .join("");
}

const TranscriptFileSchema = z.strictObject({
  sessionId: z.string(),
  createdAt: z.number(),
  events: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("user-message"),
        id: z.string(),
        timestamp: z.number(),
        step: z.number(),
        content: z.string(),
      }),
      z.strictObject({
        type: z.literal("text-delta"),
        id: z.string(),
        timestamp: z.number(),
        step: z.number(),
        text: z.string(),
      }),
      z.strictObject({
        type: z.literal("tool-call"),
        id: z.string(),
        timestamp: z.number(),
        step: z.number(),
        toolName: z.string(),
        toolCallId: z.string(),
        input: z.unknown(),
      }),
      z.strictObject({
        type: z.literal("tool-result"),
        id: z.string(),
        timestamp: z.number(),
        step: z.number(),
        toolName: z.string(),
        toolCallId: z.string(),
        output: z.string(),
        isError: z.boolean(),
      }),
      z.strictObject({
        type: z.literal("loop-error"),
        id: z.string(),
        timestamp: z.number(),
        step: z.number(),
        error: z.string(),
      }),
    ]),
  ),
});

export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

export async function saveSessionTranscript(
  state: Pick<SessionTranscriptState, "sessionId" | "createdAt" | "events">,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const data: TranscriptFile = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    events: state.events,
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
): Promise<StoreApi<SessionTranscriptState>> {
  const filePath = join(dir, `${sessionId}.json`);
  const raw = await readFile(filePath, "utf-8");
  const parsed = TranscriptFileSchema.parse(JSON.parse(raw));

  if (parsed.sessionId !== sessionId) {
    throw new Error(
      `Session ID mismatch: expected "${sessionId}", found "${parsed.sessionId}" in file`,
    );
  }

  const store = createSessionStore(sessionId);
  store.setState({
    sessionId: parsed.sessionId,
    createdAt: parsed.createdAt,
    events: parsed.events,
  });

  return store;
}
