import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CompletedToolPart,
  ExecutionModelBindingSummary,
  MessageModelAudit,
  SessionExecutionInputCheckpoint,
  SessionExecutionRecord,
  SessionMessage,
  SessionStep,
  ToolChildSessionLink,
} from "@archcode/protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  __setExecutionTurnRenderObserverForTest,
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

function completedTool(
  id: string,
  path: string,
  createdAt: number,
  toolName = "file_read",
): CompletedToolPart {
  return {
    type: "tool",
    id,
    state: "completed",
    toolCallId: `call-${id}`,
    toolName,
    input: { path },
    result: {
      isError: false,
      output: {
        preview: `contents of ${path}`,
        completeness: "complete",
        observed: { bytes: 10, lines: 1 },
        canonical: { bytes: 10, lines: 1 },
        stored: { bytes: 10, lines: 1 },
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
    },
    createdAt,
    startedAt: createdAt,
    endedAt: createdAt + 1,
  };
}

function terminalSteps(executions: readonly SessionExecutionRecord[]): SessionStep[] {
  return executions.flatMap((record, index) => record.status === "completed" ? [{
    id: `step-${record.id}`,
    step: index,
    executionId: record.id,
    startedAt: record.startedAt,
    completedAt: record.endedAt ?? record.startedAt + 1,
    finishReason: "stop",
  }] : []);
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
  childSessionLinks: ToolChildSessionLink[] = [],
  steps: SessionStep[] = terminalSteps(executions),
) {
  const store = createWebSessionStore(sessionId, slug);
  store.getState().initializeFromSnapshot({
    rootSessionId: sessionId,
    agentName: "lead",
    eventCursor: -1,
    messages,
    executions,
    steps,
    executionInputCheckpoints,
    childSessionLinks,
  });
  return store;
}

function turn(executionId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="execution-turn-${executionId}"]`);
  if (!element) throw new Error(`Missing Execution turn ${executionId}`);
  return element;
}

function workDisclosure(executionId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="work-disclosure-${executionId}"]`);
  if (!element) throw new Error(`Missing Work disclosure ${executionId}`);
  return element;
}

function workSummary(executionId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="work-summary-${executionId}"]`);
  if (!(element instanceof dom.window.HTMLButtonElement)) {
    throw new Error(`Missing Work summary ${executionId}`);
  }
  return element;
}

function workBody(executionId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="work-body-${executionId}"]`);
}

function finalResponse(executionId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="final-response-${executionId}"]`);
}

async function clickWork(executionId: string): Promise<void> {
  await act(async () => workSummary(executionId).click());
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
  __setExecutionTurnRenderObserverForTest(undefined);
  __resetWebSessionStoresForTest();
  clearExecutionWorkstreamUiState("project-1");
  clearExecutionWorkstreamUiState("other-project");
  dom.window.close();
});

describe("ExecutionWorkstream", () => {
  test("projects every authoritative Execution status without inferring state from messages", async () => {
    const statuses: Array<[SessionExecutionRecord["status"], string, string | undefined, string]> = [
      ["running", "Working", undefined, "running"],
      ["waiting_for_human", "Needs you", undefined, "needs_you"],
      ["completed", "Worked for", undefined, "completed"],
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
      expect(turn(`execution-${status}`).textContent).toContain(label);
      if (detail) expect(turn(`execution-${status}`).textContent).toContain(detail);
      if (detail) expect(workSummary(`execution-${status}`).getAttribute("aria-label")).toContain(detail);
      expect(workDisclosure(`execution-${status}`).getAttribute("data-visual-kind")).toBe(visualKind);
    }
    expect(turn("execution-waiting_for_human").textContent).not.toContain("Paused for input");
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

    expect(turn("source").textContent).toContain("Input received");
    expect(turn("source").textContent).toContain("Continued in Execution 2");
    expect(turn("source").textContent).not.toContain("Needs you");
  });

  test("collapses completed Work while keeping its final response visible, and expands running Work", async () => {
    const store = initializeSession([
      message("user-old", "user", "old", "Old request", 1),
      message("assistant-old", "assistant", "old", "Old final", 2),
      message("user-live", "user", "live", "Live request", 3),
      message("assistant-live", "assistant", "live", "Live progress", 4),
    ], [execution("old", 1), execution("live", 3, "running")]);

    await renderWorkstream();

    expect(workSummary("old").getAttribute("aria-expanded")).toBe("false");
    expect(workBody("old")).toBeNull();
    expect(finalResponse("old")?.textContent).toContain("Old final");
    expect(workSummary("live").getAttribute("aria-expanded")).toBe("true");
    expect(workBody("live")?.textContent).toContain("Live progress");
    expect(finalResponse("live")).toBeNull();

    await act(async () => {
      store.setState((state) => ({
        executions: state.executions.map((record) => record.id === "live"
          ? { ...record, status: "completed" as const, endedAt: 5, durationMs: 2 }
          : record),
        steps: [...state.steps, {
          id: "live-step", step: 0, executionId: "live", startedAt: 3, completedAt: 5, finishReason: "stop",
        }],
        messages: [...state.messages, message("assistant-final", "assistant", "live", "Live final", 5)],
      }));
      await Promise.resolve();
    });

    expect(workSummary("live").getAttribute("aria-expanded")).toBe("false");
    expect(workBody("live")).toBeNull();
    expect(finalResponse("live")?.textContent).toContain("Live final");
  });

  test("joins ordered final Text parts before parsing one Markdown document", async () => {
    const finalMessage: SessionMessage = {
      id: "final-message",
      role: "assistant",
      executionId: "execution",
      createdAt: 2,
      completedAt: 2,
      parts: [
        { type: "text", id: "final-a", text: "**Joined", createdAt: 2, completedAt: 2 },
        { type: "text", id: "final-b", text: " output**", createdAt: 2, completedAt: 2 },
      ],
    };
    initializeSession([
      message("user", "user", "execution", "Join the output", 1),
      finalMessage,
    ], [execution("execution", 1)]);

    await renderWorkstream();

    const rendered = finalResponse("execution");
    expect(rendered?.textContent).toContain("Joined output");
    expect(rendered?.querySelectorAll(".conversation-part")).toHaveLength(1);
    expect(rendered?.querySelector(".conversation-part")?.textContent).toBe("Joined output");
    expect(rendered?.querySelector(".conversation-part")?.textContent).not.toContain("**");
  });

  test("uses an accessible Work disclosure and unmounts only its process body", async () => {
    initializeSession([
      message("user-old", "user", "old", "Old body marker", 1),
      message("assistant-work", "assistant", "old", "Old work marker", 2),
      message("assistant-old", "assistant", "old", "Old final marker", 3),
      message("user-latest", "user", "latest", "Latest body marker", 4),
      message("assistant-latest", "assistant", "latest", "Latest final marker", 5),
    ], [execution("old", 1), execution("latest", 2)]);
    await renderWorkstream();

    const summary = workSummary("old");
    expect(summary.textContent).toContain("Worked for");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.getAttribute("aria-controls")).toBe("work-body-old");
    expect(workBody("old")).toBeNull();
    expect(finalResponse("old")?.textContent).toContain("Old final marker");

    await clickWork("old");
    expect(workSummary("old").getAttribute("aria-expanded")).toBe("true");
    expect(workBody("old")?.id).toBe("work-body-old");
    expect(workBody("old")?.textContent).toContain("Old work marker");
    expect(workBody("old")?.textContent).not.toContain("Old body marker");
    expect(finalResponse("old")?.textContent).toContain("Old final marker");

    await clickWork("old");
    expect(workBody("old")).toBeNull();
    expect(finalResponse("old")?.textContent).toContain("Old final marker");
  });

  test("keeps Tool, child, and compaction detail inside Work without hiding the final response", async () => {
    const workMessage: SessionMessage = {
      id: "working",
      role: "assistant",
      executionId: "execution",
      createdAt: 2,
      completedAt: 2,
      parts: [
        { type: "reasoning", id: "reasoning", text: "Reasoning detail", createdAt: 2, completedAt: 2 },
        { type: "tool", id: "read", state: "pending", toolCallId: "read-call", toolName: "file_read", createdAt: 3 },
        { type: "tool", id: "delegate", state: "pending", toolCallId: "delegate-call", toolName: "delegate", createdAt: 4 },
        { type: "compaction", id: "compact", summary: "Compaction detail", tailStartId: "tail", compactedAt: 5 },
      ],
    };
    const child: ToolChildSessionLink = {
      parentSessionId: "session-1",
      parentToolCallId: "delegate-call",
      toolName: "delegate",
      childSessionId: "child-1",
      childAgentName: "explore",
      childProfile: "fast",
      childSkillNames: [],
      title: "Inspect code",
      depth: 1,
      background: false,
      status: "completed",
      createdAt: 4,
    };
    initializeSession([
      message("user", "user", "execution", "Please inspect", 1),
      workMessage,
      message("final", "assistant", "execution", "Inspection complete", 6),
    ], [execution("execution", 1)], "session-1", "project-1", [], [child]);

    await renderWorkstream();

    expect(finalResponse("execution")?.textContent).toContain("Inspection complete");
    expect(container.textContent).not.toContain("file_read");
    expect(container.textContent).not.toContain("Inspect code");
    expect(container.textContent).not.toContain("Hard context compaction");

    await clickWork("execution");
    expect(workBody("execution")?.textContent).toContain("file_read");
    expect(workBody("execution")?.textContent).toContain("Inspect code");
    expect(workBody("execution")?.textContent).toContain("Hard context compaction");
    expect(finalResponse("execution")?.textContent).toContain("Inspection complete");
  });

  test("does not render an empty final-response shell when a Tool directly completes an Execution", async () => {
    const record = execution("tool-only", 1);
    const toolOnly: SessionMessage = {
      id: "tool-only-message",
      role: "assistant",
      executionId: "tool-only",
      createdAt: 2,
      completedAt: 2,
      parts: [{ type: "tool", id: "read", state: "pending", toolCallId: "read-call", toolName: "file_read", createdAt: 2 }],
    };
    initializeSession([
      message("user", "user", "tool-only", "Read the file", 1),
      toolOnly,
    ], [record], "session-1", "project-1", [], [], [{
      id: "tool-only-step",
      step: 0,
      executionId: "tool-only",
      startedAt: 1,
      completedAt: 2,
      finishReason: "tool-calls",
    }]);

    await renderWorkstream();

    expect(workSummary("tool-only").getAttribute("aria-expanded")).toBe("false");
    expect(finalResponse("tool-only")).toBeNull();
    await clickWork("tool-only");
    expect(workBody("tool-only")?.textContent).toContain("file_read");
  });

  test("renders text, five tools, text, and three tools as two settled Tool Runs", async () => {
    const intro = message("intro", "assistant", "execution", "First commentary", 2);
    const firstToolNames = ["file_read", "grep", "glob", "bash", "lsp_symbols"];
    const firstTools: SessionMessage = {
      id: "first-tools",
      role: "assistant",
      executionId: "execution",
      createdAt: 3,
      completedAt: 8,
      parts: Array.from({ length: 5 }, (_, index) =>
        completedTool(
          `first-${index + 1}`,
          `first-${index + 1}.ts`,
          index + 3,
          firstToolNames[index],
        )
      ),
    };
    const middle = message("middle", "assistant", "execution", "Second commentary", 9);
    const secondToolNames = ["memory_read", "output_search", "git_diff"];
    const secondTools: SessionMessage = {
      id: "second-tools",
      role: "assistant",
      executionId: "execution",
      createdAt: 10,
      completedAt: 13,
      parts: Array.from({ length: 3 }, (_, index) =>
        completedTool(
          `second-${index + 1}`,
          `second-${index + 1}.ts`,
          index + 10,
          secondToolNames[index],
        )
      ),
    };
    initializeSession([
      message("user", "user", "execution", "Inspect both phases", 1),
      intro,
      firstTools,
      middle,
      secondTools,
    ], [execution("execution", 1)], "session-1", "project-1", [], [], [{
      id: "terminal",
      step: 0,
      executionId: "execution",
      startedAt: 1,
      completedAt: 14,
      finishReason: "stop",
    }]);

    await renderWorkstream();
    await clickWork("execution");

    const body = workBody("execution");
    const runs = body?.querySelectorAll<HTMLElement>('[data-testid="tool-run-card"]');
    expect(runs).toHaveLength(2);
    expect(runs?.[0]?.querySelector('[data-testid="tool-run-tool-names"]')?.textContent).toBe(
      firstToolNames.join(", "),
    );
    expect(runs?.[1]?.querySelector('[data-testid="tool-run-tool-names"]')?.textContent).toBe(
      secondToolNames.join(", "),
    );
    expect(runs?.[0]?.textContent).not.toContain("first-1.ts");
    expect(runs?.[1]?.textContent).not.toContain("second-1.ts");

    const bodyText = body?.textContent ?? "";
    expect(bodyText.indexOf("First commentary")).toBeLessThan(bodyText.indexOf(firstToolNames[0]));
    expect(bodyText.indexOf(firstToolNames[0])).toBeLessThan(bodyText.indexOf("Second commentary"));
    expect(bodyText.indexOf("Second commentary")).toBeLessThan(bodyText.indexOf(secondToolNames[0]));

    const firstRunToggle = runs?.[0]?.querySelector("button");
    if (!(firstRunToggle instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Tool Run toggle");
    await act(async () => firstRunToggle.click());
    const expandedTools = runs?.[0]?.querySelectorAll<HTMLElement>("[data-tool-card]");
    expect(expandedTools).toHaveLength(5);
    expect(Array.from(expandedTools ?? [], (tool) => tool.textContent)).toEqual([
      expect.stringContaining("first-1.ts"),
      expect.stringContaining("first-2.ts"),
      expect.stringContaining("first-3.ts"),
      expect.stringContaining("first-4.ts"),
      expect.stringContaining("first-5.ts"),
    ]);
    expect(runs?.[0]?.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(5);
  });

  test("keeps running Work in authoritative message and part order with user-right and plain agent presentation", async () => {
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
    ], [execution("execution", 1, "running")]);

    await renderWorkstream();

    const bodyText = workBody("execution")?.textContent ?? "";
    const turnText = turn("execution").textContent ?? "";
    expect(bodyText).not.toContain("User request");
    expect(turnText.indexOf("User request")).toBeLessThan(turnText.indexOf("Agent part one"));
    expect(bodyText.indexOf("Agent part one")).toBeLessThan(bodyText.indexOf("Agent part two"));
    expect(bodyText.indexOf("Agent part two")).toBeLessThan(bodyText.indexOf("Agent part three"));

    const user = container.querySelector<HTMLElement>('[data-message-kind="canonical-user"]');
    const userBubble = user?.querySelector<HTMLElement>(".justify-end > div");
    expect(userBubble?.className).toContain("max-w-[640px]");
    expect(userBubble?.className).toContain("rounded-xl");
    expect(userBubble?.className).toContain("bg-bg-active");
    expect(userBubble?.className).not.toContain("shadow-");

    const agent = container.querySelector<HTMLElement>('[data-message-kind="agent"]');
    expect(agent).not.toBeNull();
    expect(agent?.className).toContain("max-w-[740px]");
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
    expect(container.querySelectorAll('[data-testid^="execution-turn-"]')).toHaveLength(0);
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

    await clickWork("execution");
    expect(container.querySelector('[data-testid="message-model-change-audited"]')?.textContent)
      .toBe("Model changed: test:removed → test:model");
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

  test("does not auto-collapse a completed Work after the reader has manually chosen its disclosure state", async () => {
    const store = initializeSession([
      message("user", "user", "live", "Live request", 1),
      message("progress", "assistant", "live", "Live progress", 2),
    ], [execution("live", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    scroller.scrollTop = 600;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));

    await clickWork("live");
    await clickWork("live");
    expect(workSummary("live").getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      store.setState((state) => ({
        executions: state.executions.map((record) => ({
          ...record,
          status: "completed" as const,
          endedAt: 3,
          durationMs: 2,
        })),
        steps: [...state.steps, {
          id: "live-step", step: 0, executionId: "live", startedAt: 1, completedAt: 3, finishReason: "stop",
        }],
        messages: [...state.messages, message("final", "assistant", "live", "Completed final", 3)],
      }));
    });

    expect(workSummary("live").getAttribute("aria-expanded")).toBe("true");
    expect(workBody("live")?.textContent).toContain("Live progress");
    expect(finalResponse("live")?.textContent).toContain("Completed final");
  });

  test("keeps an historical reader's running Work expanded when it completes away from the bottom", async () => {
    const store = initializeSession([
      message("user-history", "user", "history", "Historical request", 1),
      message("assistant-history", "assistant", "history", "Historical final", 2),
      message("user-live", "user", "live", "Live request", 3),
      message("assistant-live", "assistant", "live", "Live progress", 4),
    ], [execution("history", 1), execution("live", 3, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    scroller.scrollTop = 200;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));

    await act(async () => {
      store.setState((state) => ({
        executions: state.executions.map((record) => record.id === "live"
          ? { ...record, status: "completed" as const, endedAt: 5, durationMs: 2 }
          : record),
        steps: [...state.steps, {
          id: "live-step", step: 0, executionId: "live", startedAt: 3, completedAt: 5, finishReason: "stop",
        }],
        messages: [...state.messages, message("assistant-final", "assistant", "live", "Live final", 5)],
      }));
    });

    expect(workSummary("live").getAttribute("aria-expanded")).toBe("true");
    expect(workBody("live")?.textContent).toContain("Live progress");
    expect(scroller.scrollTop).toBe(200);
  });

  test("preserves the disclosure anchor instead of scrolling to the Session bottom", async () => {
    initializeSession([
      message("user-old", "user", "old", "Old request", 1),
      message("assistant-old", "assistant", "old", "Old final", 2),
      message("user-latest", "user", "latest", "Latest request", 3),
      message("assistant-latest", "assistant", "latest", "Latest final", 4),
    ], [execution("old", 1), execution("latest", 3)]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    scroller.scrollTop = 275;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));

    await clickWork("old");
    expect(Math.abs(scroller.scrollTop - 275)).toBeLessThanOrEqual(1);
    expect(scroller.scrollTop).not.toBe(2_000);

    await clickWork("old");
    expect(Math.abs(scroller.scrollTop - 275)).toBeLessThanOrEqual(1);
    expect(scroller.scrollTop).not.toBe(2_000);
  });

  test("gives a disclosure anchor priority over a batched near-bottom stream update", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Historical request", 1),
      message("final", "assistant", "execution", "Historical final", 2),
    ], [execution("execution", 1)]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    scroller.scrollTop = 1_500;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));

    const summary = workSummary("execution");
    Object.defineProperty(summary, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(
        0,
        summary.getAttribute("aria-expanded") === "true" ? 240 : 180,
        300,
        44,
      ),
    });

    await act(async () => {
      summary.click();
      store.setState((state) => ({
        messages: [...state.messages, message("stream", "assistant", "execution", "Batched stream update", 3)],
      }));
    });

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(scroller.scrollTop).toBe(1_560);
    expect(scroller.scrollTop).not.toBe(2_000);
  });

  test("retains per-Session UI state across focus remounts and clears it at route lifecycle end", async () => {
    const releaseStrictMount = retainExecutionWorkstreamUiState("project-1", "session-1");
    initializeSession([
      message("user-old", "user", "old", "Old body", 1),
      message("user-latest", "user", "latest", "Latest body", 2),
    ], [execution("old", 1), execution("latest", 2)]);
    await renderWorkstream();
    await clickWork("old");

    releaseStrictMount();
    const releaseMountedRoute = retainExecutionWorkstreamUiState("project-1", "session-1");
    await Promise.resolve();
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderWorkstream();
    expect(workBody("old")).not.toBeNull();
    expect(workBody("latest")).toBeNull();

    await act(async () => root.unmount());
    releaseMountedRoute();
    await Promise.resolve();
    root = createRoot(container);
    await renderWorkstream();
    expect(workBody("old")).toBeNull();
    expect(workBody("latest")).toBeNull();
  });

  test("keeps a 1k Execution history collapsed and updates only the active projection within budget", async () => {
    const executions: SessionExecutionRecord[] = [];
    const messages: SessionMessage[] = [];
    const renderCounts = new Map<string, number>();
    __setExecutionTurnRenderObserverForTest((executionId) => {
      renderCounts.set(executionId, (renderCounts.get(executionId) ?? 0) + 1);
    });
    for (let executionIndex = 0; executionIndex < 1_000; executionIndex += 1) {
      const executionId = `execution-${executionIndex}`;
      executions.push(execution(
        executionId,
        executionIndex,
        executionIndex === 999 ? "running" : "completed",
      ));
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
    const store = initializeSession(messages, executions);

    await renderWorkstream();

    expect(container.querySelectorAll('[data-testid^="execution-turn-"]')).toHaveLength(1_000);
    expect(container.querySelectorAll('[data-testid^="work-summary-"]')).toHaveLength(1_000);
    expect(container.querySelectorAll('[data-testid^="work-body-"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="final-response-"]')).toHaveLength(999);
    expect(container.textContent).toContain("part-b-999-9");
    expect(container.querySelectorAll('[data-message-kind="canonical-user"]')).toHaveLength(5_000);
    expect(container.querySelectorAll('[data-message-kind="agent"]')).toHaveLength(1_004);

    const historicalRenderCount = renderCounts.get("execution-0");
    const activeRenderCount = renderCounts.get("execution-999");
    const startedAt = performance.now();
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message(
          "active-stream",
          "assistant",
          "execution-999",
          "Active stream update",
          20_001,
        )],
      }));
    });
    const updateDurationMs = performance.now() - startedAt;

    expect(renderCounts.get("execution-0")).toBe(historicalRenderCount);
    expect(renderCounts.get("execution-999")).toBeGreaterThan(activeRenderCount ?? 0);
    expect(workBody("execution-999")?.textContent).toContain("Active stream update");
    expect(finalResponse("execution-999")).toBeNull();
    expect(container.querySelectorAll('[data-testid^="execution-turn-"]')).toHaveLength(1_000);
    expect(updateDurationMs).toBeLessThan(1_000);
  });
});
