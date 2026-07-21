import { describe, expect, test } from "bun:test";
import type { SessionEventSourceEvent } from "./session-event-bridge";
import { SessionEventBridge } from "./session-event-bridge";
import { testRequestedModelSelection } from "../testing/test-execution-fixtures";

const workspaceRoot = "/workspace";

class FakeSessionEventSource {
  readonly listeners = new Set<(event: SessionEventSourceEvent) => void>();

  subscribeToSessionEvents(listener: (event: SessionEventSourceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: {
    sessionId: string;
    eventId: number;
    payload?: SessionEventSourceEvent["envelope"]["payload"];
    workspace?: string;
  }): void {
    const event: SessionEventSourceEvent = {
      workspaceRoot: input.workspace ?? workspaceRoot,
      sessionId: input.sessionId,
      agentName: "lead",
      envelope: {
        id: input.eventId,
        createdAt: 10 + input.eventId,
        payload: input.payload ?? { type: "system-notice", message: `event-${input.eventId}` },
      },
    };
    for (const listener of this.listeners) listener(event);
  }
}

describe("SessionEventBridge", () => {
  test("forwards a durable source event with the global SSE wire shape", () => {
    const source = new FakeSessionEventSource();
    const bridge = new SessionEventBridge({
      source,
      resolveProjectSlug: (workspace) => workspace === workspaceRoot ? "project" : undefined,
    });
    const received: unknown[] = [];
    bridge.subscribe((event) => received.push(event));

    source.emit({
      sessionId: "root",
      eventId: 7,
      payload: { type: "session.message_accepted", message: {
        id: "message-1",
        clientRequestId: "request-1",
        content: "queued while idle",
        source: "user",
        state: "queued",
        revision: 0,
        acceptedAt: 10,
        updatedAt: 10,
        requestedModelSelection: testRequestedModelSelection,
      } },
    });

    expect(received).toEqual([{
      type: "event",
      slug: "project",
      sessionId: "root",
      eventId: 7,
      createdAt: 17,
      agentName: "lead",
      payload: expect.objectContaining({ type: "session.message_accepted" }),
    }]);
  });

  test("forwards every Session in a registered workspace without Execution attachment", () => {
    const source = new FakeSessionEventSource();
    const bridge = new SessionEventBridge({
      source,
      resolveProjectSlug: (workspace) => workspace === workspaceRoot ? "project" : undefined,
    });
    const received: unknown[] = [];
    bridge.subscribe((event) => received.push(event));

    source.emit({ sessionId: "other", eventId: 0 });
    source.emit({ sessionId: "root", eventId: 0, workspace: "/other-workspace" });
    source.emit({ sessionId: "root", eventId: 0 });

    expect(received).toEqual([
      expect.objectContaining({ slug: "project", sessionId: "other" }),
      expect.objectContaining({ slug: "project", sessionId: "root" }),
    ]);
  });

  test("projects the current workspace slug at publication time", () => {
    const source = new FakeSessionEventSource();
    let slug = "project-a";
    const bridge = new SessionEventBridge({ source, resolveProjectSlug: () => slug });
    const received: unknown[] = [];
    bridge.subscribe((event) => received.push(event));

    source.emit({ sessionId: "root", eventId: 0 });
    slug = "project-b";
    source.emit({ sessionId: "root", eventId: 1 });

    expect(received).toEqual([
      expect.objectContaining({ slug: "project-a", eventId: 0 }),
      expect.objectContaining({ slug: "project-b", eventId: 1 }),
    ]);
  });

  test("unsubscribe and close release their respective listeners", () => {
    const source = new FakeSessionEventSource();
    const bridge = new SessionEventBridge({ source, resolveProjectSlug: () => "project" });
    const received: unknown[] = [];
    const unsubscribe = bridge.subscribe((event) => received.push(event));

    unsubscribe();
    source.emit({ sessionId: "root", eventId: 0 });
    expect(received).toEqual([]);

    expect(source.listeners.size).toBe(1);
    bridge.close();
    expect(source.listeners.size).toBe(0);
  });
});
