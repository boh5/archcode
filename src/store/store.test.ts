import { describe, expect, test, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createSessionStore, getSessionStore } from "./store";
import { getAssistantText, saveSessionTranscript, loadSessionTranscript } from "./helpers";
import type { TranscriptEvent, SessionTranscriptState } from "./types";
import type { StoreApi } from "zustand";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<TranscriptEvent> & { type: TranscriptEvent["type"] }): TranscriptEvent {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    step: 0,
    ...overrides,
  } as TranscriptEvent;
}

describe("createSessionStore", () => {
  test("creates a store with the given session id", () => {
    const id = randomUUID();
    const store = createSessionStore(id);
    const state = store.getState();
    expect(state.sessionId).toBe(id);
    expect(state.events).toEqual([]);
    expect(state.createdAt).toBeGreaterThan(0);
  });

  test("returns the same store for the same session id", () => {
    const id = randomUUID();
    const store1 = createSessionStore(id);
    const store2 = createSessionStore(id);
    expect(store1).toBe(store2);
  });

  test("append adds an event to the events array", () => {
    const store = createSessionStore(randomUUID());
    const event = makeEvent({ type: "text-delta", text: "hello" });
    store.getState().append(event);
    expect(store.getState().events).toEqual([event]);
  });

  test("append preserves previous events (immutable)", () => {
    const store = createSessionStore(randomUUID());
    const event1 = makeEvent({ type: "text-delta", text: "a" });
    const event2 = makeEvent({ type: "text-delta", text: "b" });
    store.getState().append(event1);
    store.getState().append(event2);
    expect(store.getState().events).toEqual([event1, event2]);
  });
});

describe("getSessionStore", () => {
  test("returns undefined for unknown session id", () => {
    expect(getSessionStore("nonexistent")).toBeUndefined();
  });

  test("returns the store after creation", () => {
    const id = randomUUID();
    const store = createSessionStore(id);
    expect(getSessionStore(id)).toBe(store);
  });
});

describe("getAssistantText", () => {
  test("returns empty string for no events", () => {
    expect(getAssistantText([])).toBe("");
  });

  test("concatenates text-delta events only", () => {
    const events: TranscriptEvent[] = [
      makeEvent({ type: "user-message", content: "hi" }),
      makeEvent({ type: "text-delta", text: "Hello" }),
      makeEvent({ type: "text-delta", text: " world" }),
      makeEvent({ type: "tool-call", toolName: "read", toolCallId: "tc1", input: {} }),
    ];
    expect(getAssistantText(events)).toBe("Hello world");
  });
});

describe("saveSessionTranscript + loadSessionTranscript", () => {
  test("roundtrips transcript data correctly", async () => {
    const sessionId = randomUUID();
    const createdAt = Date.now();

    const events: TranscriptEvent[] = [
      makeEvent({ type: "user-message", step: 0, content: "write a function" }),
      makeEvent({ type: "text-delta", step: 0, text: "Sure," }),
      makeEvent({ type: "text-delta", step: 0, text: " I can help." }),
      makeEvent({ type: "tool-call", step: 0, toolName: "readFile", toolCallId: "tc1", input: { path: "src/index.ts" } }),
      makeEvent({ type: "tool-result", step: 0, toolName: "readFile", toolCallId: "tc1", output: "file contents", isError: false }),
    ];

    await saveSessionTranscript({ sessionId, createdAt, events }, TMP_DIR);

    const loadedStore = await loadSessionTranscript(sessionId, TMP_DIR);
    const loadedState = loadedStore.getState();

    expect(loadedState.sessionId).toBe(sessionId);
    expect(loadedState.createdAt).toBe(createdAt);
    expect(loadedState.events).toEqual(events);
  });

  test("persists all event types including errors", async () => {
    const sessionId = randomUUID();

    const events: TranscriptEvent[] = [
      makeEvent({ type: "tool-result", step: 1, toolName: "bash", toolCallId: "tc2", output: "command failed", isError: true }),
      makeEvent({ type: "loop-error", step: 2, error: "max steps reached" }),
    ];

    await saveSessionTranscript({ sessionId, createdAt: Date.now(), events }, TMP_DIR);

    const loadedStore = await loadSessionTranscript(sessionId, TMP_DIR);
    expect(loadedStore.getState().events).toEqual(events);
  });

  test("uses atomic write (no .tmp file remains)", async () => {
    const sessionId = randomUUID();
    const events: TranscriptEvent[] = [
      makeEvent({ type: "user-message", content: "test" }),
    ];

    await saveSessionTranscript({ sessionId, createdAt: Date.now(), events }, TMP_DIR);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(TMP_DIR);
    const sessionFiles = files.filter((f) => f.includes(sessionId));
    expect(sessionFiles).toEqual([`${sessionId}.json`]);
  });

  test("load rejects on corrupted JSON", async () => {
    const sessionId = randomUUID();
    await mkdir(TMP_DIR, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(TMP_DIR, `${sessionId}.json`), "not json", "utf-8");

    expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects on schema-invalid data", async () => {
    const sessionId = randomUUID();
    await mkdir(TMP_DIR, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(TMP_DIR, `${sessionId}.json`),
      JSON.stringify({ sessionId, createdAt: 123, events: [{ type: "unknown" }] }),
      "utf-8",
    );

    expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects when sessionId in file does not match parameter", async () => {
    const fileSessionId = randomUUID();
    const requestSessionId = randomUUID();
    await mkdir(TMP_DIR, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(TMP_DIR, `${requestSessionId}.json`),
      JSON.stringify({ sessionId: fileSessionId, createdAt: 123, events: [] }),
      "utf-8",
    );

    expect(loadSessionTranscript(requestSessionId, TMP_DIR)).rejects.toThrow(
      /mismatch/i,
    );
  });
});
