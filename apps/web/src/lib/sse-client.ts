import { EventSourceParserStream } from "eventsource-parser/stream";
import { apiBaseUrl, createApiHeaders } from "../api/client";

export const INITIAL_RECONNECT_DELAY_MS = 1_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

export interface ConnectSSEOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  onEvent: (event: SSEEvent) => void;
  onError?: (error: unknown) => void;
}

export interface SSEClient {
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  abort: () => void;
}

export class HTTPStatusError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly url: string;

  constructor(input: { status: number; statusText: string; url: string }) {
    super(`SSE request failed with status ${input.status}`);
    this.name = "HTTPStatusError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.url = input.url;
  }
}

export function connectSSE(path: string, options: ConnectSSEOptions): SSEClient {
  const controller = new AbortController();
  const signal = controller.signal;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

  const abort = () => {
    if (signal.aborted) return;
    controller.abort();
  };

  const clearReconnectTimeout = () => {
    if (reconnectTimeout === undefined) return;
    clearTimeout(reconnectTimeout);
    reconnectTimeout = undefined;
  };

  const abortFromExternalSignal = () => abort();
  options.signal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  signal.addEventListener("abort", clearReconnectTimeout, { once: true });

  const closed = runSSELoop({
    path,
    signal,
    options,
    getReconnectDelay: () => reconnectDelayMs,
    increaseReconnectDelay: () => {
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    },
    resetReconnectDelay: () => {
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    },
    setReconnectTimeout: (timeout) => {
      reconnectTimeout = timeout;
    },
  }).finally(() => {
    clearReconnectTimeout();
    options.signal?.removeEventListener("abort", abortFromExternalSignal);
  });

  return { signal, closed, abort };
}

async function runSSELoop(input: {
  path: string;
  signal: AbortSignal;
  options: ConnectSSEOptions;
  getReconnectDelay: () => number;
  increaseReconnectDelay: () => void;
  resetReconnectDelay: () => void;
  setReconnectTimeout: (timeout: ReturnType<typeof setTimeout> | undefined) => void;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      await connectOnce(input.path, input.options, input.signal);
      if (input.signal.aborted) break;
      input.resetReconnectDelay();
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) break;
      input.options.onError?.(error);
    }

    if (input.signal.aborted) break;
    const delay = input.getReconnectDelay();
    input.increaseReconnectDelay();
    await waitForReconnect(delay, input.signal, input.setReconnectTimeout);
  }
}

async function connectOnce(
  path: string,
  options: ConnectSSEOptions,
  signal: AbortSignal,
): Promise<void> {
  const url = `${apiBaseUrl()}${path}`;
  const response = await fetch(url, {
    headers: createApiHeaders(options.headers),
    signal,
  });

  if (!response.ok) {
    throw new HTTPStatusError({ status: response.status, statusText: response.statusText, url });
  }

  if (!response.body) return;

  const eventStream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  for await (const event of eventStream) {
    if (signal.aborted) break;
    options.onEvent({ event: event.event ?? "message", data: event.data, id: event.id });
  }
}

function waitForReconnect(
  delay: number,
  signal: AbortSignal,
  setReconnectTimeout: (timeout: ReturnType<typeof setTimeout> | undefined) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      setReconnectTimeout(undefined);
      resolve();
    }, delay);

    setReconnectTimeout(timeout);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
