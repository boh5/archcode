import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type { StoreApi } from "zustand";
import type { Agent, AgentResult, AgentRunOptions } from "../../agents/types";
import type { SpecraRuntime } from "../../main";
import { ProjectRegistry } from "../../projects/registry";
import { createSessionStore } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import type { ToolConfirmationCallback } from "../../tools";
import { AgentRunner } from "../agent-runner";
import { errorHandler } from "../error-handler";
import { createEventsRoutes, sessionStreams } from "./events";

const tempRoot = resolve(import.meta.dir, "..", "__test_tmp__", "events-routes");

const createScopedSessionStore = createSessionStore as unknown as typeof createSessionStore & ((sessionId: string, workspaceRoot: string) => ReturnType<typeof createSessionStore>);

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

class MockAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly runMock: RunMock;

  constructor(sessionId: string, workspaceRoot: string) {
    this.store = createScopedSessionStore(sessionId, workspaceRoot);
    this.runMock = mock(async () => ({ text: "ok", steps: 1 }));
  }

  run(
    userMessage: string,
    abort?: AbortSignal,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> {
    return this.runMock(userMessage, options);
  }

  dispose(): void {}
}

function createTestRuntime(projectRegistry: ProjectRegistry, agent: Agent): SpecraRuntime {
  const sessionId = agent.store.getState().sessionId;
  return {
    sessionAgentManager: {
      get: (_workspaceRoot: string, requestedSessionId: string) => (requestedSessionId === sessionId ? agent : undefined),
      getOrCreate: async () => agent,
      dispose: () => undefined,
      disposeAll: () => undefined,
      getByWorkspace: () => [],
      isTombstoned: () => false,
      acquireSlot: () => undefined,
      releaseSlot: () => undefined,
      abortAndDispose: async () => undefined,
    },
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    agentFor: async (_workspaceRoot: string, _sessionId: string) => agent,
  } as unknown as SpecraRuntime;
}

async function createTestApp(testName: string, sessionId: string) {
  sessionStreams.clear();
  const homeDir = join(tempRoot, "homes", testName);
  const workspaceRoot = join(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const agent = new MockAgent(sessionId, workspaceRoot);
  const projectRegistry = new ProjectRegistry({ homeDir });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry, agent);
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects/:slug/sessions/:sessionId/events", createEventsRoutes(runtime, new AgentRunner(runtime)));

  return { agent, app, project };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

async function readUntil(response: Response, predicate: (text: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected response body");

  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20000;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Timed out reading SSE response")), remaining);
        }),
      ]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
      if (predicate(text)) return text;
    }
  } finally {
    await reader.cancel();
  }

  throw new Error(`SSE predicate was not satisfied. Received: ${text}`);
}

function eventPath(slug: string, sessionId: string, suffix: string = ""): string {
  return `/api/projects/${slug}/sessions/${sessionId}/events${suffix}`;
}

function streamPayloadIndex(text: string, value: string): number {
  const index = text.indexOf(`data: {"type":"system-notice","message":"${value}"}`);
  if (index === -1) throw new Error(`Missing stream payload: ${value}. Received: ${text}`);
  return index;
}

describe("events routes", () => {
  beforeEach(async () => {
    sessionStreams.clear();
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    sessionStreams.clear();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("SSE connection receives appended session envelopes from the store", async () => {
    const { agent, app, project } = await createTestApp("live-events", "live-session");
    const response = await app.request(eventPath(project.slug, "live-session"));

    agent.store.getState().append({ type: "system-notice", message: "hello" });

    const text = await readUntil(response, (chunk) => chunk.includes("system-notice"));
    expect(text).toContain("event: stream");
    expect(text).toContain("id: 0");
    expect(text).toContain('data: {"type":"system-notice","message":"hello"}');
  });

  test("Last-Event-ID header triggers cursor replay of only events after the cursor", async () => {
    const { agent, app, project } = await createTestApp("header-replay", "header-session");
    agent.store.getState().append({ type: "system-notice", message: "one" });
    agent.store.getState().append({ type: "system-notice", message: "two" });
    agent.store.getState().append({ type: "system-notice", message: "three" });

    const replay = await app.request(eventPath(project.slug, "header-session"), {
      headers: { "Last-Event-ID": "0" },
    });

    const text = await readUntil(replay, (chunk) => chunk.includes("three"));
    expect(text).not.toContain("one");
    expect(text).toContain("id: 1");
    expect(text).toContain("two");
    expect(text).toContain("id: 2");
    expect(text).toContain("three");
    expect(streamPayloadIndex(text, "two")).toBeLessThan(streamPayloadIndex(text, "three"));
  });

  test("lastEventId query parameter triggers replay", async () => {
    const { agent, app, project } = await createTestApp("query-replay", "query-session");
    agent.store.getState().append({ type: "system-notice", message: "one" });
    agent.store.getState().append({ type: "system-notice", message: "two" });

    const replay = await app.request(eventPath(project.slug, "query-session", "?lastEventId=0"));

    const text = await readUntil(replay, (chunk) => chunk.includes("two"));
    expect(text).not.toContain("one");
    expect(text).toContain("id: 1");
    expect(text).toContain("two");
  });

  test("query lastEventId takes priority over Last-Event-ID header", async () => {
    const { agent, app, project } = await createTestApp("query-priority", "priority-session");
    agent.store.getState().append({ type: "system-notice", message: "one" });
    agent.store.getState().append({ type: "system-notice", message: "two" });

    const replay = await app.request(eventPath(project.slug, "priority-session", "?lastEventId=0"), {
      headers: { "Last-Event-ID": "999" },
    });

    const text = await readUntil(replay, (chunk) => chunk.includes("two"));
    expect(text).not.toContain("one");
    expect(text).toContain("id: 1");
  });

  test("connection without a cursor replays all buffered events in order", async () => {
    const { agent, app, project } = await createTestApp("initial-replay", "initial-session");
    agent.store.getState().append({ type: "system-notice", message: "before-one" });
    agent.store.getState().append({ type: "system-notice", message: "before-two" });

    const response = await app.request(eventPath(project.slug, "initial-session"));
    const text = await readUntil(response, (chunk) => chunk.includes("before-two"));

    expect(text).toContain("id: 0");
    expect(text).toContain("before-one");
    expect(text).toContain("id: 1");
    expect(text).toContain("before-two");
    expect(streamPayloadIndex(text, "before-one")).toBeLessThan(streamPayloadIndex(text, "before-two"));
  });

  test("new events after initial replay stream to the connected client after buffered events", async () => {
    const { agent, app, project } = await createTestApp("replay-then-live", "replay-live-session");
    agent.store.getState().append({ type: "system-notice", message: "buffered" });
    const response = await app.request(eventPath(project.slug, "replay-live-session"));

    await delay(10);
    agent.store.getState().append({ type: "system-notice", message: "live" });

    const text = await readUntil(response, (chunk) => chunk.includes("live"));
    expect(text).toContain("buffered");
    expect(text).toContain("live");
    expect(text).toContain("id: 1");
    expect(streamPayloadIndex(text, "buffered")).toBeLessThan(streamPayloadIndex(text, "live"));
  });

  test("stale cursor sends reset instead of partial replay", async () => {
    const { agent, app, project } = await createTestApp("stale-reset", "stale-session");
    const state = agent.store.getState();
    state.append({ type: "system-notice", message: "first" });
    agent.store.setState((current) => ({
      events: current.events.slice(1),
      eventOffset: 1,
      nextEventId: 1,
    }));

    const replay = await app.request(eventPath(project.slug, "stale-session", "?lastEventId=-1"));

    const text = await readUntil(replay, (chunk) => chunk.includes("event: reset"));
    expect(text).toContain("data: {}");
    expect(text).not.toContain("event: stream");
  });

  test("cursor from a wrong generation sends reset", async () => {
    const { app, project } = await createTestApp("generation-reset", "generation-session");

    const replay = await app.request(eventPath(project.slug, "generation-session", "?lastEventId=999"));

    const text = await readUntil(replay, (chunk) => chunk.includes("event: reset"));
    expect(text).toContain("data: {}");
  });

  test("heartbeat is sent within 20 seconds", async () => {
    const { agent, app, project } = await createTestApp("heartbeat", "heartbeat-session");
    const response = await app.request(eventPath(project.slug, "heartbeat-session"));

    const text = await readUntil(response, (chunk) => chunk.includes("event: heartbeat"));
    expect(text).toContain("data: {}");
    expect(agent.store.getState().events).toHaveLength(0);
  }, 22000);

  test("client disconnect cleans up subscription", async () => {
    const { agent, app, project } = await createTestApp("disconnect", "disconnect-session");
    const response = await app.request(eventPath(project.slug, "disconnect-session"));
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected response body");

    await reader.cancel();
    await delay(10);

    agent.store.getState().append({ type: "system-notice", message: "after-disconnect" });
    const replay = await app.request(eventPath(project.slug, "disconnect-session"));
    const text = await readUntil(replay, (chunk) => chunk.includes("after-disconnect"));

    expect(text).toContain("after-disconnect");
  }, 22000);
});
