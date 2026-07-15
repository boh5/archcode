import type { SessionEventPayload } from "./types";

export function toDurableToolInput(input: unknown): unknown {
  return input === undefined ? null : input;
}

export function toDurableSessionEvent(event: SessionEventPayload): SessionEventPayload {
  if ((event.type !== "tool-call" && event.type !== "tool-input-resolved") || event.input !== undefined) {
    return event;
  }

  return { ...event, input: null };
}
