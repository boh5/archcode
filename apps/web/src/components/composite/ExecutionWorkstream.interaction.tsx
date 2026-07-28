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

async function userScroll(
  scroller: HTMLElement,
  scrollTop: number,
  deltaY: number,
): Promise<void> {
  await act(async () => {
    scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY }));
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  });
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
    ResizeObserver: undefined,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => {},
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
      ["max_steps", "Stopped", "Max steps", "stopped"],
      ["failed", "Stopped", "Failed", "stopped"],
      ["aborted", "Stopped", "Aborted", "stopped"],
      ["cancelled", "Stopped", "Cancelled", "stopped"],
      ["timed_out", "Stopped", "Timed out", "stopped"],
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

    for (const [status, label, detail, productStatus] of statuses) {
      expect(turn(`execution-${status}`).textContent).toContain(label);
      if (detail) expect(turn(`execution-${status}`).textContent).toContain(detail);
      if (detail) expect(workSummary(`execution-${status}`).getAttribute("aria-label")).toContain(detail);
      expect(workDisclosure(`execution-${status}`).getAttribute("data-product-status")).toBe(productStatus);
    }
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
    expect(workSummary("source").getAttribute("aria-label")).toContain("continued in Execution 2");
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
    expect(summary.className).toContain("max-w-[720px]");
    expect(summary.querySelector('[data-testid="work-divider-old"]')).not.toBeNull();
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.getAttribute("aria-controls")).toBe("work-body-old");
    expect(workBody("old")).toBeNull();
    expect(finalResponse("old")?.textContent).toContain("Old final marker");

    await clickWork("old");
    expect(workSummary("old").getAttribute("aria-expanded")).toBe("true");
    expect(workBody("old")?.id).toBe("work-body-old");
    expect(workBody("old")?.className).not.toContain("max-w-[720px]");
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

  test("does not retain a completed tool as current activity during later reasoning", async () => {
    const workMessage: SessionMessage = {
      id: "working",
      role: "assistant",
      executionId: "execution",
      createdAt: 2,
      parts: [
        completedTool("read", "finished.ts", 2),
        { type: "reasoning", id: "reasoning", text: "Now considering the result", createdAt: 4 },
      ],
    };
    initializeSession([
      message("user", "user", "execution", "Inspect", 1),
      workMessage,
    ], [execution("execution", 1, "running")], "session-1", "project-1");

    await renderWorkstream();

    expect(workSummary("execution").textContent).toContain("Working");
    expect(workSummary("execution").getAttribute("aria-label")).not.toContain("finished.ts");
    expect(workSummary("execution").getAttribute("aria-label")).not.toContain("file_read");
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
    const firstToolNames = ["file_read", "grep", "glob", "lsp_diagnostics", "lsp_symbols"];
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
    expect(firstRunToggle.className).toContain("max-w-[696px]");
    await act(async () => firstRunToggle.click());
    expect(runs?.[0]?.querySelector('[data-testid="tool-run-list"]')?.className).not.toContain("max-w-[720px]");
    const expandedTools = runs?.[0]?.querySelectorAll<HTMLElement>('[data-testid="tool-run-child"]');
    expect(expandedTools).toHaveLength(5);
    expect(Array.from(expandedTools ?? [], (tool) => tool.textContent)).toEqual([
      expect.stringContaining("first-1.ts"),
      expect.stringContaining("first-2.ts"),
      expect.stringContaining("first-3.ts"),
      expect.stringContaining("first-4.ts"),
      expect.stringContaining("first-5.ts"),
    ]);
    expect(runs?.[0]?.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(0);
  });

  test("renders model reasoning as an independent disclosure after a Tool Run", async () => {
    const leakedReasoning = "The user wants me to optimize the animation effects of the 2048 game.";
    const toolsMessage: SessionMessage = {
      id: "tools",
      role: "assistant",
      executionId: "execution",
      createdAt: 2,
      completedAt: 5,
      parts: [
        completedTool("read-one", "2048.html", 2),
        completedTool("read-two", "checklist.md", 3),
        completedTool("read-three", "findings.md", 4),
      ],
    };
    const finalMessage: SessionMessage = {
      id: "final",
      role: "assistant",
      executionId: "execution",
      createdAt: 6,
      completedAt: 7,
      parts: [
        { type: "reasoning", id: "internal-plan", text: leakedReasoning, createdAt: 6, completedAt: 7 },
        { type: "text", id: "final-text", text: "Animation review complete.", createdAt: 6, completedAt: 7 },
      ],
    };
    initializeSession(
      [
        message("user", "user", "execution", "Optimize animations", 1),
        toolsMessage,
        finalMessage,
      ],
      [execution("execution", 1)],
      "session-1",
      "project-1",
      [],
      [],
      [{
        id: "reasoning-step",
        step: 0,
        executionId: "execution",
        startedAt: 1,
        completedAt: 7,
        finishReason: "stop",
        usage: { reasoningTokens: 321 },
      }],
    );

    await renderWorkstream();
    await clickWork("execution");

    expect(workBody("execution")?.querySelectorAll('[data-testid="tool-run-card"]')).toHaveLength(1);
    expect(workBody("execution")?.textContent).toContain("file_read, file_read, file_read");
    expect(workBody("execution")?.textContent).not.toContain(leakedReasoning);
    const reasoning = workBody("execution")?.querySelector<HTMLElement>('[data-testid="reasoning-block"]');
    const toolRun = workBody("execution")?.querySelector<HTMLElement>('[data-testid="tool-run-card"]');
    expect(reasoning).not.toBeNull();
    expect(reasoning?.textContent).toContain("Reasoning");
    expect(toolRun?.contains(reasoning ?? null)).toBe(false);
    const reasoningToggle = reasoning?.querySelector("button");
    if (!(reasoningToggle instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Reasoning toggle");
    await act(async () => reasoningToggle.click());
    expect(reasoning?.textContent).toContain(leakedReasoning);
    expect(toolRun?.textContent).not.toContain(leakedReasoning);
    expect(finalResponse("execution")?.textContent).toContain("Animation review complete.");
    expect(workBody("execution")?.querySelector('[data-testid="reasoning-usage-summary"]')).toBeNull();
  });

  test("shows reasoning usage when the model reports tokens without reasoning text", async () => {
    initializeSession(
      [
        message("user", "user", "execution", "Inspect the project", 1),
        message("final", "assistant", "execution", "Inspection complete.", 3),
      ],
      [execution("execution", 1)],
      "session-1",
      "project-1",
      [],
      [],
      [{
        id: "hidden-reasoning-step",
        step: 0,
        executionId: "execution",
        startedAt: 1,
        completedAt: 3,
        finishReason: "stop",
        usage: { reasoningTokens: 1_021 },
      }],
    );

    await renderWorkstream();
    await clickWork("execution");

    const summary = workBody("execution")?.querySelector<HTMLElement>(
      '[data-testid="reasoning-usage-summary"]',
    );
    expect(summary?.textContent).toContain("Reasoning");
    expect(summary?.textContent).toContain(`${(1_021).toLocaleString()} tokens`);
    expect(summary?.textContent).not.toContain("Text not provided by model");
    expect(summary?.getAttribute("role")).toBe("note");
    expect(workBody("execution")?.querySelector('[data-testid="reasoning-block"]')).toBeNull();
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
    const userRow = user?.querySelector<HTMLElement>("[data-user-message-row]");
    const userSurface = user?.querySelector<HTMLElement>("[data-user-message-surface]");
    expect(userRow?.className).toContain("justify-end");
    expect(userRow?.className).toContain("w-full");
    expect(userSurface?.className).toContain("max-w-[660px]");
    expect(userSurface?.className).not.toContain("w-full");
    expect(userSurface?.className).toContain("rounded-lg");
    expect(userSurface?.className).toContain("bg-bg-muted");
    expect(userSurface?.className).not.toContain("shadow-");

    const agent = container.querySelector<HTMLElement>('[data-message-kind="agent"]');
    expect(agent).not.toBeNull();
    expect(agent?.className).toContain("w-full");
    expect(container.querySelector('[data-testid="agent-message-meta-assistant"]')).toBeNull();
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
  });

  test("keeps programmatic scrolling in follow mode and preserves an upward-scrolling reader", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    expect(scroller.style.scrollbarGutter).toBe("stable both-edges");
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

    await userScroll(scroller, 200, -300);
    scrollHeight = 1_400;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("far", "assistant", "execution", "Reader-safe update", 3)],
      }));
    });
    expect(scroller.scrollTop).toBe(200);
  });

  test("shows the jump control after upward intent and resumes live following from the bottom", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });

    await userScroll(scroller, 200, -300);
    const jump = container.querySelector<HTMLButtonElement>('[data-testid="scroll-to-latest"]');
    expect(jump?.getAttribute("aria-label")).toBe("Jump to latest");

    await act(async () => jump?.click());
    expect(scroller.scrollTop).toBe(1_000);
    expect(container.querySelector('[data-testid="scroll-to-latest"]')).toBeNull();
    expect(document.activeElement).toBe(scroller);

    scrollHeight = 1_200;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("stream", "assistant", "execution", "Live update", 2)],
      }));
    });
    expect(scroller.scrollTop).toBe(1_200);
  });

  test("clears boundary input intent before jumping to latest", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });

    await userScroll(scroller, 0, -300);
    await act(async () => {
      scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      await Promise.resolve();
    });
    const jump = container.querySelector<HTMLButtonElement>('[data-testid="scroll-to-latest"]');
    if (!jump) throw new Error("Missing jump control");

    await act(async () => jump.click());
    expect(scroller.scrollTop).toBe(1_000);

    scrollHeight = 1_200;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("stream-after-boundary", "assistant", "execution", "Live update", 2)],
      }));
    });
    expect(scroller.scrollTop).toBe(1_200);
  });

  test("resumes following when touch momentum reaches the bottom", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    await userScroll(scroller, 400, -200);

    const touchEvent = (type: string, clientY?: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", {
        configurable: true,
        value: clientY === undefined ? [] : [{ clientY }],
      });
      return event;
    };
    await act(async () => {
      scroller.dispatchEvent(touchEvent("touchstart", 200));
      scroller.dispatchEvent(touchEvent("touchmove", 120));
      scroller.dispatchEvent(touchEvent("touchend"));
      await Promise.resolve();
    });

    scroller.scrollTop = 580;
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="scroll-to-latest"]')).toBeNull();

    scrollHeight = 1_200;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("stream-after-touch", "assistant", "execution", "Live update", 2)],
      }));
    });
    expect(scroller.scrollTop).toBe(1_200);
  });

  test("treats Shift+Space as upward reading intent without blocking native scrolling", async () => {
    const store = initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    scroller.scrollTop = 600;
    await act(async () => scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));

    const shiftSpace = new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
      shiftKey: true,
    });
    await act(async () => {
      scroller.dispatchEvent(shiftSpace);
      scroller.scrollTop = 300;
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    expect(shiftSpace.defaultPrevented).toBe(false);

    scrollHeight = 1_200;
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message("stream-after-shift-space", "assistant", "execution", "Live update", 2)],
      }));
    });
    expect(scroller.scrollTop).toBe(300);
  });

  test("uses 24/48px hysteresis for the jump control", async () => {
    initializeSession([
      message("user", "user", "execution", "Initial", 1),
    ], [execution("execution", 1, "running")]);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    if (!scroller) throw new Error("Missing workstream scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });

    await userScroll(scroller, 560, -40);
    expect(container.querySelector('[data-testid="scroll-to-latest"]')).toBeNull();
    await userScroll(scroller, 540, -20);
    expect(container.querySelector('[data-testid="scroll-to-latest"]')).not.toBeNull();
    await userScroll(scroller, 550, 10);
    expect(container.querySelector('[data-testid="scroll-to-latest"]')).not.toBeNull();
    await userScroll(scroller, 580, 30);
    expect(container.querySelector('[data-testid="scroll-to-latest"]')).toBeNull();
  });

  test("shows an accessible Execution rail only for a long desktop transcript", async () => {
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(pointer: fine)",
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }),
    });
    const records = [
      execution("one", 1),
      execution("two", 2),
      execution("three", 3),
      { ...execution("four", 4), origin: "tool_batch" as const },
    ];
    initializeSession([
      message("user-one", "user", "one", "First request", 1),
      message("user-two", "user", "two", "Second request", 2),
      message("user-three", "user", "three", `Third ${"very long request ".repeat(20)}`, 3),
    ], records);
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    const thread = container.querySelector<HTMLElement>('[data-testid="execution-thread-column"]');
    if (!scroller || !thread) throw new Error("Missing transcript geometry");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1_200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(0, 0, 600, 400),
    });
    let threadGutter = 40;
    Object.defineProperty(thread, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(threadGutter, 0, 600 - threadGutter * 2, 1_200),
    });
    const articleTops = [0, 240, 480, 1_000];
    records.forEach((record, index) => {
      const article = turn(record.id);
      Object.defineProperty(article, "getBoundingClientRect", {
        configurable: true,
        value: () => new dom.window.DOMRect(
          40,
          (articleTops[index] ?? 0) - scroller.scrollTop,
          520,
          200,
        ),
      });
    });

    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });

    const rail = container.querySelector<HTMLElement>('[data-testid="execution-navigation-rail"]');
    expect(rail?.getAttribute("aria-label")).toBe("Execution navigation");
    expect(rail?.style.left).toBe("12px");
    const markers = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-execution-navigation-id]"),
    );
    expect(markers).toHaveLength(4);
    expect(markers[0]?.getAttribute("aria-current")).toBe("location");
    expect(markers[0]?.tabIndex).toBe(0);
    expect(markers[2]?.getAttribute("aria-label")?.length).toBeLessThan(220);
    expect(markers[2]?.getAttribute("aria-label")).toContain("…");
    expect(markers[3]?.getAttribute("aria-label")).toContain("Tool batch continuation");

    for (const [gutter, expectedLeft] of [[35, 7], [32, 4], [40, 12]] as const) {
      threadGutter = gutter;
      await act(async () => {
        scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
        await Promise.resolve();
      });
      expect(rail?.style.left).toBe(`${expectedLeft}px`);
      expect(expectedLeft + 28).toBeLessThanOrEqual(gutter);
    }

    const requestedScroll = { top: null as number | null };
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        requestedScroll.top = top ?? null;
      },
    });
    await act(async () => markers[2]?.click());
    expect(requestedScroll.top).toBe(464);
    expect(markers[2]?.getAttribute("aria-current")).toBe("location");

    scroller.scrollTop = 200;
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(markers[2]?.getAttribute("aria-current")).toBe("location");

    scroller.scrollTop = requestedScroll.top ?? 0;
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(markers[2]?.getAttribute("aria-current")).toBe("location");

    await act(async () => {
      scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      scroller.scrollTop = 800;
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    expect(markers[3]?.getAttribute("aria-current")).toBe("location");

    await act(async () => markers[1]?.focus());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("Second request");
    expect(markers[1]?.getAttribute("aria-describedby")).not.toBeNull();

    await act(async () => {
      markers[1]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowDown",
      }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(markers[2]);
  });

  test("keeps the current marker visible in a long Execution rail", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(pointer: fine)",
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }),
    });
    const records = Array.from({ length: 24 }, (_, index) => execution(`execution-${index + 1}`, index + 1));
    initializeSession(
      records.map((record, index) => message(
        `user-${record.id}`,
        "user",
        record.id,
        `Request ${index + 1}`,
        index + 1,
      )),
      records,
    );
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    const thread = container.querySelector<HTMLElement>('[data-testid="execution-thread-column"]');
    if (!scroller || !thread) throw new Error("Missing transcript geometry");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 6_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(0, 0, 600, 400),
    });
    Object.defineProperty(thread, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(40, 0, 520, 6_000),
    });
    let articleRectReads = 0;
    records.forEach((record, index) => {
      Object.defineProperty(turn(record.id), "getBoundingClientRect", {
        configurable: true,
        value: () => {
          articleRectReads += 1;
          return new dom.window.DOMRect(40, index * 240 - scroller.scrollTop, 520, 200);
        },
      });
    });

    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(articleRectReads).toBeLessThan(10);

    const rail = container.querySelector<HTMLElement>('[data-testid="execution-navigation-rail"]');
    const markers = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-execution-navigation-id]"),
    );
    if (!rail || markers.length !== records.length) throw new Error("Missing long Execution rail");
    const lastMarker = markers.at(-1);
    if (!lastMarker) throw new Error("Missing last Execution marker");
    let railHeight = 200;
    Object.defineProperty(rail, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(12, 100, 28, railHeight),
    });
    markers.forEach((marker, index) => {
      Object.defineProperty(marker, "getBoundingClientRect", {
        configurable: true,
        value: () => new dom.window.DOMRect(12, 112 + index * 24 - rail.scrollTop, 28, 24),
      });
    });

    await act(async () => {
      lastMarker.click();
      await Promise.resolve();
    });
    expect(lastMarker.getAttribute("aria-current")).toBe("location");
    expect(rail.scrollTop).toBeGreaterThan(0);
    expect(rail.getAttribute("style")).toContain(
      "max-height: min(70vh, 40rem, calc(100% - 16px))",
    );

    const scrollTopBeforeResize = rail.scrollTop;
    railHeight = 80;
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver);
      }
    });
    expect(rail.scrollTop).toBeGreaterThan(scrollTopBeforeResize);
    expect(lastMarker.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(rail.getBoundingClientRect().bottom - 12);

    await act(async () => lastMarker.focus());
    expect(document.activeElement).toBe(lastMarker);
    scroller.scrollTop = 0;
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(markers[0]?.getAttribute("aria-current")).toBe("location");
    expect(rail.scrollTop).toBe(0);
  });

  test("does not show the Execution rail when the transcript does not overflow", async () => {
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        media: "(pointer: fine)",
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }),
    });
    const records = ["one", "two", "three", "four"].map((id, index) => execution(id, index + 1));
    initializeSession(
      records.map((record, index) => message(`user-${record.id}`, "user", record.id, `Request ${index + 1}`, index + 1)),
      records,
    );
    await renderWorkstream();

    const scroller = container.querySelector<HTMLElement>('[data-testid="execution-workstream-scroller"]');
    const thread = container.querySelector<HTMLElement>('[data-testid="execution-thread-column"]');
    if (!scroller || !thread) throw new Error("Missing transcript geometry");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(0, 0, 600, 400),
    });
    Object.defineProperty(thread, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(40, 0, 520, 400),
    });

    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="execution-navigation-rail"]')).toBeNull();
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
    await userScroll(scroller, 200, -300);

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

  test("keeps historical Work collapsed and updates only the active projection", async () => {
    const executions: SessionExecutionRecord[] = [
      execution("execution-0", 0),
      execution("execution-1", 1),
      execution("execution-2", 2, "running"),
    ];
    const messages: SessionMessage[] = executions.flatMap((record, executionIndex) => [
      message(
        `user-${executionIndex}`,
        "user",
        record.id,
        `User request ${executionIndex}`,
        executionIndex * 2,
      ),
      message(
        `assistant-${executionIndex}`,
        "assistant",
        record.id,
        `Agent response ${executionIndex}`,
        executionIndex * 2 + 1,
      ),
    ]);
    const renderCounts = new Map<string, number>();
    __setExecutionTurnRenderObserverForTest((executionId) => {
      renderCounts.set(executionId, (renderCounts.get(executionId) ?? 0) + 1);
    });
    const store = initializeSession(messages, executions);

    await renderWorkstream();

    expect(container.querySelectorAll('[data-testid^="execution-turn-"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid^="work-summary-"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid^="work-body-"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="final-response-"]')).toHaveLength(2);
    expect(container.textContent).toContain("Agent response 2");

    const historicalRenderCount = renderCounts.get("execution-0");
    const activeRenderCount = renderCounts.get("execution-2");
    await act(async () => {
      store.setState((state) => ({
        messages: [...state.messages, message(
          "active-stream",
          "assistant",
          "execution-2",
          "Active stream update",
          7,
        )],
      }));
    });

    expect(renderCounts.get("execution-0")).toBe(historicalRenderCount);
    expect(renderCounts.get("execution-2")).toBeGreaterThan(activeRenderCount ?? 0);
    expect(workBody("execution-2")?.textContent).toContain("Active stream update");
    expect(finalResponse("execution-2")).toBeNull();
    expect(container.querySelectorAll('[data-testid^="execution-turn-"]')).toHaveLength(3);
  });
});
