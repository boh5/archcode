import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ExecutionModelBindingSummary,
  MessageModelAudit,
  SessionExecutionInputCheckpoint,
  SessionExecutionRecord,
  SessionMessage,
} from "@archcode/protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  clearExecutionWorkstreamUiState,
  ExecutionWorkstream,
  retainExecutionWorkstreamUiState,
} from "./ExecutionWorkstream";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
} from "../../store/session-store";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const binding: ExecutionModelBindingSummary = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test Provider",
  modelDisplayName: "Test Model",
  resolution: "profile_default",
  modelRuntimeRevision: "m1",
};

const sessionIdentity = { agentName: "lead", profile: "principal" as const };
const agents = [{ name: "lead", displayName: "Lead Engineer" }];

function execution(
  id: string,
  startedAt: number,
  status: SessionExecutionRecord["status"] = "completed",
): SessionExecutionRecord {
  return {
    id,
    startedAt,
    ...(status === "running"
      ? {}
      : { endedAt: startedAt + 10, durationMs: 10 }),
    status,
    binding,
    origin: "user_message",
  };
}

function message(
  id: string,
  role: SessionMessage["role"],
  executionId: string | undefined,
  text: string,
  createdAt: number,
  modelAudit?: MessageModelAudit,
): SessionMessage {
  return {
    id,
    role,
    ...(executionId === undefined ? {} : { executionId }),
    createdAt,
    completedAt: createdAt,
    ...(modelAudit ? { modelAudit } : {}),
    parts: [{
      type: "text",
      id: `${id}-text`,
      text,
      createdAt,
      completedAt: createdAt,
    }],
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

async function renderWorkstream(
  sessionId = "session-1",
  slug = "project-1",
  onInspectModelAudit?: (messageId: string) => void,
): Promise<void> {
  const client = createClient();
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <ExecutionWorkstream
            slug={slug}
            sessionId={sessionId}
            sessionIdentity={sessionIdentity}
            agents={agents}
            onInspectModelAudit={onInspectModelAudit}
          />
        </QueryClientProvider>
      </StrictMode>,
    );
    await Promise.resolve();
  });
}

function initializeSession(
  messages: SessionMessage[],
  executions: SessionExecutionRecord[],
  sessionId = "session-1",
  slug = "project-1",
  executionInputCheckpoints: SessionExecutionInputCheckpoint[] = [],
) {
  const store = createWebSessionStore(sessionId, slug);
  store.getState().initializeFromSnapshot({
    rootSessionId: sessionId,
    agentName: "lead",
    eventCursor: -1,
    messages,
    executions,
    executionInputCheckpoints,
  });
  return store;
}

function card(executionId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="execution-card-${executionId}"]`);
  if (!element) throw new Error(`Missing Execution card ${executionId}`);
  return element;
}

function body(executionId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="execution-body-${executionId}"]`);
}

async function clickCard(executionId: string): Promise<void> {
  const button = card(executionId).querySelector("button");
  if (!(button instanceof dom.window.HTMLButtonElement)) {
    throw new Error(`Missing Execution toggle ${executionId}`);
  }
  await act(async () => button.click());
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    scrollIntoView: { configurable: true, value: () => {} },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
  clearExecutionWorkstreamUiState("project-1");
  clearExecutionWorkstreamUiState("other-project");
});

afterEach(() => {
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  clearExecutionWorkstreamUiState("project-1");
  clearExecutionWorkstreamUiState("other-project");
  dom.window.close();
});

describe("ExecutionWorkstream", () => {
  test("projects every authoritative Execution status without inferring state from messages", async () => {
    const statuses: Array<[SessionExecutionRecord["status"], string, string | undefined, string]> = [
      ["running", "Running", undefined, "running"],
      ["waiting_for_human", "Needs you", undefined, "needs_you"],
      ["completed", "Completed", undefined, "completed"],
      ["max_steps", "Stopped", "Max steps", "failed"],
      ["failed", "Stopped", "Failed", "failed"],
      ["aborted", "Stopped", "Aborted", "stopped"],
      ["cancelled", "Stopped", "Cancelled", "stopped"],
      ["timed_out", "Stopped", "Timed out", "failed"],
      ["interrupted", "Stopped", "Interrupted", "stopped"],
    ];
    initializeSession(
      statuses.map(([status], index) => message(
        `message-${status}`,
        "user",
        `execution-${status}`,
        `Message claims completed ${status}`,
        index + 1,
      )),
      statuses.map(([status], index) => execution(`execution-${status}`, index + 1, status)),
    );

    await renderWorkstream();

    for (const [status, label, detail, visualKind] of statuses) {
      expect(card(`execution-${status}`).textContent).toContain(label);
      if (detail) expect(card(`execution-${status}`).textContent).toContain(detail);
      expect(card(`execution-${status}`).getAttribute("data-visual-kind")).toBe(visualKind);
    }
    expect(card("execution-waiting_for_human").textContent).not.toContain("Paused for input");
  });

  test("shows a resolved input checkpoint and its continuation Execution", async () => {
    const source = execution("source", 1, "waiting_for_human");
    const continuation = { ...execution("continuation", 20, "completed"), origin: "tool_batch" as const };
    initializeSession(
      [
        message("user-source", "user", "source", "Ask me a question", 1),
        message("assistant-continuation", "assistant", "continuation", "Thanks for the answer", 20),
      ],
      [source, continuation],
      "session-1",
      "project-1",
      [{ executionId: "source", state: "continued", continuationExecutionId: "continuation" }],
    );

    await renderWorkstream();

    expect(card("source").textContent).toContain("Input received");
    expect(card("source").textContent).toContain("Continued in Execution 2");
    expect(card("source").textContent).not.toContain("Needs you");
  });

  test("opens the latest Execution by default, then opens a newly running Execution", async () => {
    const store = initializeSession([
      message("user-old", "user", "old", "Old request", 1),
      message("user-latest", "user", "latest", "Latest request", 2),
    ], [execution("old", 1), execution("latest", 2)]);

    await renderWorkstream();

    expect(body("old")).toBeNull();
    expect(body("latest")).not.toBeNull();

    await act(async () => {
      store.setState((state) => ({
        executions: [...state.executions, execution("running", 3, "running")],
        messages: [...state.messages, message("user-running", "user", "running", "Live request", 3)],
      }));
      await Promise.resolve();
    });

    expect(body("latest")).not.toBeNull();
    expect(body("running")).not.toBeNull();
  });

  test("toggles Execution cards independently and unmounts collapsed bodies", async () => {
    initializeSession([
      message("user-old", "user", "old", "Old body marker", 1),
      message("user-latest", "user", "latest", "Latest body marker", 2),
    ], [execution("old", 1), execution("latest", 2)]);
    await renderWorkstream();

    expect(body("old")).toBeNull();
    expect(card("old").querySelector('[data-message-kind="canonical-user"]')).toBeNull();

    await clickCard("old");
    expect(body("old")).not.toBeNull();
    expect(body("latest")).not.toBeNull();

    await clickCard("latest");
    expect(body("old")).not.toBeNull();
    expect(body("latest")).toBeNull();
    expect(card("latest").querySelector('[data-message-kind="canonical-user"]')).toBeNull();
  });

  test("preserves authoritative message and part order with user-right and plain agent presentation", async () => {
    const orderedAssistant: SessionMessage = {
      id: "assistant",
      role: "assistant",
      executionId: "execution",
      createdAt: 2,
      completedAt: 2,
      parts: [
        { type: "text", id: "part-one", text: "Agent part one", createdAt: 2, completedAt: 2 },
        { type: "system-notice", id: "part-two", notice: "Agent part two", createdAt: 3, completedAt: 3 },
        { type: "text", id: "part-three", text: "Agent part three", createdAt: 4, completedAt: 4 },
      ],
    };
    initializeSession([
      message("user", "user", "execution", "User request", 1),
      orderedAssistant,
    ], [execution("execution", 1)]);

    await renderWorkstream();

    const text = body("execution")?.textContent ?? "";
    expect(text.indexOf("User request")).toBeLessThan(text.indexOf("Agent part one"));
    expect(text.indexOf("Agent part one")).toBeLessThan(text.indexOf("Agent part two"));
    expect(text.indexOf("Agent part two")).toBeLessThan(text.indexOf("Agent part three"));

    const user = container.querySelector<HTMLElement>('[data-message-kind="canonical-user"]');
    const userBubble = user?.querySelector<HTMLElement>(".justify-end > div");
    expect(userBubble?.className).toContain("rounded-md");
    expect(userBubble?.className).toContain("bg-bg-elevated");
    expect(userBubble?.className).not.toContain("shadow-");

    const agent = container.querySelector<HTMLElement>('[data-message-kind="agent"]');
    expect(agent).not.toBeNull();
    expect(agent?.className).not.toContain("rounded");
    expect(agent?.className).not.toContain("border-agent");
    expect(agent?.className).not.toContain("bg-agent");
    expect(agent?.querySelector("img")).toBeNull();
    expect(agent?.querySelector('[data-agent-avatar]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-message-meta-assistant"]')?.textContent).toContain("Lead Engineer·principal·");
  });

  test("renders each typed integrity diagnostic once without hiding its message", async () => {
    initializeSession([
      message("orphan", "assistant", undefined, "Orphan payload", 1),
      message("unknown", "assistant", "missing", "Unknown payload", 2),
      message("duplicate", "assistant", "duplicate-id", "Duplicate payload", 3),
    ], [
      execution("duplicate-id", 3),
      execution("duplicate-id", 4),
    ]);

    await renderWorkstream();

    expect(container.querySelectorAll('[data-testid="workstream-diagnostic-orphan_message"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="workstream-diagnostic-unknown_execution"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="workstream-diagnostic-duplicate_execution"]')).toHaveLength(1);
    expect(container.textContent).toContain("Message is missing an Execution reference");
    expect(container.textContent).toContain("Message references unknown Execution missing");
    expect(container.textContent).toContain("Duplicate Execution id duplicate-id");
    expect(container.textContent?.match(/Orphan payload/g)).toHaveLength(1);
    expect(container.textContent?.match(/Unknown payload/g)).toHaveLength(1);
    expect(container.textContent?.match(/Duplicate payload/g)).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="execution-card-"]')).toHaveLength(0);
  });

  test("keeps invalidated model audit visible and routes Details to the inspector", async () => {
    const inspectModelAudit = mock((_messageId: string) => {});
    initializeSession([
      message("audited", "user", "execution", "Use removed model", 1, {
        requested: { mode: "session_override", selection: { model: "test:removed" } },
        actual: { model: "test:model" },
        reason: "config_invalidated",
      }),
      message("answer", "assistant", "execution", "Historical answer", 2),
    ], [execution("execution", 1)]);

    await renderWorkstream("session-1", "project-1", inspectModelAudit);

    expect(container.querySelector('[data-testid="message-model-change-audited"]')?.textContent)
      .toBe("Model changed: test:removed → test:model");
    expect(container.querySelector('[data-testid="execution-model-execution"]')?.textContent).toContain("Test Model");
    const details = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Details");
    if (!(details instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Details button");
    await act(async () => details.click());
    expect(inspectModelAudit).toHaveBeenCalledWith("audited");
  });

  test("shows the Execution-specific empty state", async () => {
    initializeSession([], []);
    await renderWorkstream();

    expect(container.textContent).toContain("No executions yet");
    expect(container.textContent).not.toContain("No messages yet");
  });

  test("auto-follows within 100px of bottom and preserves a reader more than 100px away", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    expect(scroller.style.scrollbarGutter).toBe("stable");
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });

    scroller.scrollTop = 500;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));
    scrollHeight = 1_200;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("near", "assistant", "execution", "Near-bottom update", 2)],
      }));
    });
    expect(scroller.scrollTop).toBe(1_200);

    scroller.scrollTop = 200;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));
    scrollHeight = 1_400;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("far", "assistant", "execution", "Reader-safe update", 3)],
      }));
    });
    expect(scroller.scrollTop).toBe(200);
  });

  test("retains per-Session UI state across focus remounts and clears it at route lifecycle end", async () => {
    const releaseStrictMount = retainExecutionWorkstreamUiState("project-1", "session-1");
    initializeSession([
      message("user-old", "user", "old", "Old body", 1),
      message("user-latest", "user", "latest", "Latest body", 2),
    ], [execution("old", 1), execution("latest", 2)]);
    await renderWorkstream();
    await clickCard("old");
    await clickCard("latest");

    releaseStrictMount();
    const releaseMountedRoute = retainExecutionWorkstreamUiState("project-1", "session-1");
    await Promise.resolve();
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderWorkstream();
    expect(body("old")).not.toBeNull();
    expect(body("latest")).toBeNull();

    await act(async () => root.unmount());
    releaseMountedRoute();
    await Promise.resolve();
    root = createRoot(container);
    await renderWorkstream();
    expect(body("old")).toBeNull();
    expect(body("latest")).not.toBeNull();
  });

  test("keeps a 1k Execution / 10k message / 20k part history collapsed in the DOM", async () => {
    const executions: SessionExecutionRecord[] = [];
    const messages: SessionMessage[] = [];
    for (let executionIndex = 0; executionIndex < 1_000; executionIndex += 1) {
      const executionId = `execution-${executionIndex}`;
      executions.push(execution(executionId, executionIndex));
      for (let messageIndex = 0; messageIndex < 10; messageIndex += 1) {
        const id = `message-${executionIndex}-${messageIndex}`;
        const createdAt = executionIndex * 10 + messageIndex;
        messages.push({
          id,
          role: messageIndex % 2 === 0 ? "user" : "assistant",
          executionId,
          createdAt,
          completedAt: createdAt,
          parts: [
            { type: "text", id: `${id}-a`, text: `part-a-${executionIndex}-${messageIndex}`, createdAt, completedAt: createdAt },
            { type: "text", id: `${id}-b`, text: `part-b-${executionIndex}-${messageIndex}`, createdAt, completedAt: createdAt },
          ],
        });
      }
    }
    initializeSession(messages, executions);

    await renderWorkstream();

    expect(container.querySelectorAll('[data-testid^="execution-card-"]')).toHaveLength(1_000);
    expect(container.querySelectorAll('[data-testid^="execution-body-"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("part-b-0-9");
    expect(container.textContent).toContain("part-b-999-9");
    expect(container.querySelectorAll('[data-message-kind="canonical-user"], [data-message-kind="agent"]')).toHaveLength(10);
  });
});
