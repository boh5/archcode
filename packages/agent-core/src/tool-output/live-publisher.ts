import { MAX_EVENTS } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import type { SessionStoreState } from "../store/types";
import { safeUtf8Start } from "./utf8";

export const LIVE_TOOL_OUTPUT_INTERVAL_MS = 100;
export const LIVE_TOOL_OUTPUT_EVENT_MAX_BYTES = 4 * 1024;
export const LIVE_TOOL_OUTPUT_EVENT_MAX_COUNT = 10_000;

interface LiveToolOutputTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveToolOutputPublisherOptions {
  readonly store: StoreApi<SessionStoreState>;
  readonly toolCallId: string;
  readonly timer?: LiveToolOutputTimer;
  readonly intervalMs?: number;
  readonly eventMaxBytes?: number;
  readonly eventMaxCount?: number;
}

const defaultTimer: LiveToolOutputTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Bounded, best-effort projection of canonical Bash output into the existing
 * Session event stream. It never owns process draining, capture, or final data.
 */
export class LiveToolOutputPublisher {
  readonly #store: StoreApi<SessionStoreState>;
  readonly #toolCallId: string;
  readonly #timer: LiveToolOutputTimer;
  readonly #intervalMs: number;
  readonly #eventMaxBytes: number;
  readonly #eventMaxCount: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #pending = new Uint8Array();
  #pendingOmittedBytes = 0;
  #timerHandle: unknown;
  #publishedCount = 0;
  #stopped = false;

  constructor(options: LiveToolOutputPublisherOptions) {
    this.#store = options.store;
    this.#toolCallId = options.toolCallId;
    this.#timer = options.timer ?? defaultTimer;
    this.#intervalMs = options.intervalMs ?? LIVE_TOOL_OUTPUT_INTERVAL_MS;
    this.#eventMaxBytes = options.eventMaxBytes ?? LIVE_TOOL_OUTPUT_EVENT_MAX_BYTES;
    this.#eventMaxCount = options.eventMaxCount ?? LIVE_TOOL_OUTPUT_EVENT_MAX_COUNT;
    if (
      !Number.isSafeInteger(this.#intervalMs)
      || this.#intervalMs < 1
      || !Number.isSafeInteger(this.#eventMaxBytes)
      || this.#eventMaxBytes < 4
      || !Number.isSafeInteger(this.#eventMaxCount)
      || this.#eventMaxCount < 1
    ) {
      throw new TypeError("Invalid live tool output publisher bounds");
    }
  }

  pushCanonical(bytes: Uint8Array): void {
    if (this.#stopped || bytes.byteLength === 0) return;
    try {
      const combined = concatBytes(this.#pending, bytes);
      const start = safeUtf8Start(
        combined,
        Math.max(0, combined.byteLength - this.#eventMaxBytes),
      );
      this.#pendingOmittedBytes += start;
      this.#pending = combined.subarray(start).slice();
      this.#schedule();
    } catch {
      this.#stop();
    }
  }

  flush(): void {
    if (this.#stopped || this.#pending.byteLength === 0) return;
    this.#clearTimer();

    try {
      const state = this.#store.getState();
      const unpublishedCount = state.nextEventId - state.publishableNextEventId;
      if (
        this.#publishedCount >= this.#eventMaxCount
        || unpublishedCount >= MAX_EVENTS
      ) {
        this.#stop();
        return;
      }

      const liveLimitReached =
        this.#publishedCount + 1 >= this.#eventMaxCount
        || unpublishedCount + 1 >= MAX_EVENTS;
      const delta = this.#decoder.decode(this.#pending);
      const omittedBytes = this.#pendingOmittedBytes;
      this.#pending = new Uint8Array();
      this.#pendingOmittedBytes = 0;

      // The budget check and ordinary append are one synchronous isolate turn,
      // so concurrent publishers share the unpublished suffix without a race.
      this.#store.getState().append({
        type: "tool-output-delta",
        toolCallId: this.#toolCallId,
        toolName: "bash",
        delta,
        omittedBytes,
        liveLimitReached,
      });
      this.#publishedCount += 1;
      if (liveLimitReached) this.#stop();
    } catch {
      this.#stop();
    }
  }

  dispose(): void {
    if (this.#stopped) return;
    this.flush();
    this.#stop();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  #schedule(): void {
    if (this.#timerHandle !== undefined) return;
    this.#timerHandle = this.#timer.setTimeout(() => {
      this.#timerHandle = undefined;
      this.flush();
    }, this.#intervalMs);
  }

  #clearTimer(): void {
    if (this.#timerHandle === undefined) return;
    this.#timer.clearTimeout(this.#timerHandle);
    this.#timerHandle = undefined;
  }

  #stop(): void {
    this.#clearTimer();
    this.#pending = new Uint8Array();
    this.#pendingOmittedBytes = 0;
    this.#stopped = true;
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}
