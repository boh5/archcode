import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand";
import type {
  SessionTranscriptState,
  TranscriptEvent,
} from "./types";

const sessionRegistry = new Map<string, StoreApi<SessionTranscriptState>>();

export function createSessionStore(
  sessionId: string,
): StoreApi<SessionTranscriptState> {
  const existing = sessionRegistry.get(sessionId);
  if (existing) return existing;

  const store = createStore<SessionTranscriptState>((set) => ({
    sessionId,
    events: [],
    createdAt: Date.now(),
    append: (event: TranscriptEvent) =>
      set((state) => ({ events: [...state.events, event] })),
  }));

  sessionRegistry.set(sessionId, store);
  return store;
}

export function getSessionStore(
  sessionId: string,
): StoreApi<SessionTranscriptState> | undefined {
  return sessionRegistry.get(sessionId);
}
