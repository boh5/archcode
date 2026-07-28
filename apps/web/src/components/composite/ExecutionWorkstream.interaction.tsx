import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ExecutionModelBindingSummary,
  SessionExecutionRecord,
  SessionMessage,
  SessionStep,
} from "@archcode/protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  clearExecutionWorkstreamUiState,
  ExecutionWorkstream,
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
  providerDisplayName: "Test",
  modelDisplayName: "Test Model",
  resolution: "profile_default",
  modelRuntimeRevision: "m1",
};
const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
};

function completed(id = "execution"): SessionExecutionRecord {
  return {
    id,
    startedAt: 0,
    origin: "user_message",
    maxSteps: 10,
    durationMs: 100,
    status: "completed",
    endedAt: 100,
    runs: [
      {
        ordinal: 0,
        startedAt: 0,
        endedAt: 100,
        durationMs: 100,
        binding,
        usageDelta: usage,
        settlement: { key: `run:${id}`, goalInstanceId: null },
      },
    ],
    terminalSettlement: { key: `terminal:${id}`, goalInstanceId: null },
  };
}

function running(id = "execution"): SessionExecutionRecord {
  return {
    id,
    startedAt: 0,
    origin: "user_message",
    maxSteps: 10,
    durationMs: 0,
    status: "running",
    runs: [{ ordinal: 0, startedAt: 0, binding }],
  };
}

function suspended(
  kind: "hitl" | "child_dependency" | "resume_pending",
): SessionExecutionRecord {
  const suspension =
    kind === "hitl"
      ? { kind, toolBatchId: "batch", blockerIds: ["hitl"] as string[] }
      : kind === "child_dependency"
        ? {
            kind,
            toolBatchId: "batch",
            toolCallId: "call",
            childSessionId: "child",
            childExecutionId: "child-execution",
          }
        : { kind, toolBatchId: "batch", readyAt: 10 };
  return {
    id: "execution",
    startedAt: 0,
    origin: "user_message",
    maxSteps: 10,
    durationMs: 10,
    status: "suspended",
    suspension,
    runs: [
      {
        ordinal: 0,
        startedAt: 0,
        endedAt: 10,
        durationMs: 10,
        binding,
        usageDelta: usage,
        settlement: { key: "run", goalInstanceId: null },
      },
    ],
  } as SessionExecutionRecord;
}

function message(
  id: string,
  role: SessionMessage["role"],
  value: string,
  createdAt: number,
): SessionMessage {
  return {
    id,
    role,
    executionId: "execution",
    createdAt,
    completedAt: createdAt,
    parts: [
      {
        type: "text",
        id: `${id}:text`,
        text: value,
        createdAt,
        completedAt: createdAt,
      },
    ],
  };
}

async function render(
  messages: SessionMessage[],
  execution: SessionExecutionRecord,
  steps: SessionStep[] = [],
): Promise<void> {
  await act(async () => {
    createWebSessionStore("session", "project")
      .getState()
      .initializeFromSnapshot({
        executionCount: 1,
        isRunning: execution.status === "running",
        isStreamingModel: false,
        currentExecutionId:
          execution.status === "completed" ? undefined : execution.id,
        currentAssistantMessageId: undefined,
        rootSessionId: "session",
        agentName: "lead",
        eventCursor: -1,
        messages,
        executions: [execution],
        steps,
      });
    root.render(
      <StrictMode>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <ExecutionWorkstream
            slug="project"
            sessionId="session"
            sessionIdentity={{ agentName: "lead", profile: "principal" }}
            agents={[]}
          />
        </QueryClientProvider>
      </StrictMode>,
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
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
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: undefined,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
  clearExecutionWorkstreamUiState("project");
});
afterEach(() => {
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  clearExecutionWorkstreamUiState("project");
  dom.window.close();
});

describe("ExecutionWorkstream", () => {
  test("renders ordered independent Work Segments while final output stays with the last segment", async () => {
    await render(
      [
        message("input", "user", "Initial request", 10),
        message("early", "assistant", "Early work", 20),
        message("steer", "user", "Steer the work", 40),
        message("late", "assistant", "Later work", 50),
        message("final", "assistant", "Done", 90),
      ],
      completed(),
      [
        {
          id: "step",
          executionId: "execution",
          runOrdinal: 0,
          step: 1,
          startedAt: 80,
          completedAt: 90,
          finishReason: "stop",
        },
      ],
    );
    const first = "work:execution:after:input";
    const second = "work:execution:after:steer";
    expect(
      container.querySelector(`[data-work-segment="${first}"]`)?.textContent,
    ).toContain("Initial request");
    expect(
      container.querySelector(`[data-work-segment="${second}"]`)?.textContent,
    ).toContain("Steer the work");
    expect(
      container.querySelector(`[data-testid="work-summary-${first}"]`)
        ?.textContent,
    ).toContain("Worked for");
    expect(
      container.querySelector(`[data-work-segment="${first}"]`)?.textContent,
    ).toContain("Early work");
    expect(
      container.querySelector(`[id="work-body-${first}"]`),
    ).toBeNull();
    expect(container.textContent?.match(/Early work/g)).toHaveLength(1);
    expect(
      container
        .querySelector(`[data-testid="final-response-execution"]`)
        ?.closest(`[data-work-segment="${second}"]`),
    ).not.toBeNull();
  });

  test("shows the navigation rail at its Segment threshold and jumps to each user input", async () => {
    const threeSegments = [
      message("input", "user", "Initial request", 10),
      message("work-1", "assistant", "First work", 20),
      message("steer-1", "user", "First steer", 30),
      message("work-2", "assistant", "Second work", 40),
      message("steer-2", "user", "Second steer", 50),
      message("work-3", "assistant", "Third work", 60),
    ];
    const configureGeometry = () => {
      const scroller = container.querySelector<HTMLElement>(
        '[data-testid="execution-workstream-scroller"]',
      );
      const thread = container.querySelector<HTMLElement>(
        "[data-session-thread-column]",
      );
      const targets = Array.from(
        container.querySelectorAll<HTMLElement>(
          "[data-execution-navigation-target]",
        ),
      );
      if (!scroller || !thread)
        throw new Error("Missing transcript geometry");
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        get: () => 1_200,
      });
      Object.defineProperty(scroller, "clientHeight", {
        configurable: true,
        get: () => 400,
      });
      Object.defineProperty(scroller, "getBoundingClientRect", {
        configurable: true,
        value: () => new dom.window.DOMRect(0, 0, 600, 400),
      });
      Object.defineProperty(thread, "getBoundingClientRect", {
        configurable: true,
        value: () => new dom.window.DOMRect(40, 0, 520, 1_200),
      });
      targets.forEach((target, index) => {
        Object.defineProperty(target, "getBoundingClientRect", {
          configurable: true,
          value: () =>
            new dom.window.DOMRect(
              40,
              index * 240 - scroller.scrollTop,
              520,
              200,
            ),
        });
      });
      return scroller;
    };

    await render(threeSegments, completed());
    let scroller = configureGeometry();
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="execution-navigation-rail"]'),
    ).toBeNull();

    await render([
      ...threeSegments,
      message("steer-3", "user", "Third steer", 70),
      message("work-4", "assistant", "Fourth work", 80),
    ], completed());
    scroller = configureGeometry();
    let requestedTop: number | undefined;
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        requestedTop = top;
      },
    });
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });

    const markers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "[data-execution-navigation-id]",
      ),
    );
    expect(markers).toHaveLength(4);
    expect(markers.map((marker) => marker.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("Message 1, Initial request"),
      expect.stringContaining("Message 2, First steer"),
      expect.stringContaining("Message 3, Second steer"),
      expect.stringContaining("Message 4, Third steer"),
    ]);

    await act(async () => markers[2]!.click());
    expect(requestedTop).toBe(464);
    expect(markers[2]!.getAttribute("aria-current")).toBe("location");
  });

  test("marks only the latest Segment as Working for a running Execution", async () => {
    await render(
      [
        message("input", "user", "Initial request", 10),
        message("early", "assistant", "Early work", 20),
        message("steer", "user", "Steer the work", 40),
        message("late", "assistant", "Later work", 50),
      ],
      running(),
    );
    const first = "work:execution:after:input";
    const latest = "work:execution:after:steer";

    expect(container.querySelector(`[data-testid="work-summary-${first}"]`)?.textContent)
      .toContain("Worked for");
    expect(container.querySelector(`[data-testid="work-summary-${first}"]`)?.textContent)
      .not.toContain("Working");
    expect(container.querySelector(`[data-testid="work-summary-${latest}"]`)?.textContent)
      .toContain("Working for");
  });

  test("shows a suspended status only on the latest Segment", async () => {
    await render(
      [
        message("input", "user", "Initial request", 10),
        message("early", "assistant", "Early work", 20),
        message("steer", "user", "Steer the work", 40),
        message("late", "assistant", "Later work", 50),
      ],
      suspended("hitl"),
    );
    const first = "work:execution:after:input";
    const latest = "work:execution:after:steer";

    expect(container.querySelector(`[data-testid="work-summary-${first}"]`)?.textContent)
      .toContain("Worked for");
    expect(container.querySelector(`[data-testid="work-summary-${first}"]`)?.textContent)
      .not.toContain("Needs you");
    expect(container.querySelector(`[data-testid="work-summary-${latest}"]`)?.textContent)
      .toContain("Needs you");
  });

  test("auto-collapses the latest Segment when its Execution completes", async () => {
    const messages = [
      message("input", "user", "Initial request", 10),
      message("early", "assistant", "Early work", 20),
      message("steer", "user", "Steer the work", 40),
      message("late", "assistant", "Later work", 50),
    ];
    await render(messages, running());
    const latest = "work:execution:after:steer";
    expect(container.querySelector(`[data-testid="work-disclosure-${latest}"]`)
      ?.getAttribute("data-work-expanded")).toBe("true");

    await render(messages, completed());
    expect(container.querySelector(`[data-testid="work-disclosure-${latest}"]`)
      ?.getAttribute("data-work-expanded")).toBe("false");
  });

  test("shows each durable suspended reason", async () => {
    for (const [kind, label] of [
      ["hitl", "Needs you"],
      ["child_dependency", "Waiting on child"],
      ["resume_pending", "Resuming"],
    ] as const) {
      await render([message("input", "user", "Request", 0)], suspended(kind));
      expect(container.textContent).toContain(label);
    }
  });
});
