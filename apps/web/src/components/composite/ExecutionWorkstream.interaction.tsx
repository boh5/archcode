import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AssistantSessionPart,
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
  currentSessionSnapshotGeneration,
} from "../../store/session-store";
import { sessionAuthoritativeSnapshot } from "../../test-support/session-authoritative-snapshot";

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
  outputPhase: "commentary" | "final_answer" = "commentary",
): SessionMessage {
  if (role === "user") {
    return {
      id,
      role,
      executionId: "execution",
      createdAt,
      completedAt: createdAt,
      parts: [{
        type: "text",
        id: `${id}:text`,
        text: value,
        createdAt,
        completedAt: createdAt,
      }],
    };
  }
  return {
    id,
    role,
    executionId: "execution",
    runOrdinal: 0,
    stepId: `step:${id}`,
    outputPhase,
    createdAt,
    completedAt: createdAt,
    parts: [{
      type: "assistant-output",
      id: `${id}:output`,
      blockId: `${id}:block`,
      text: value,
      createdAt,
      completedAt: createdAt,
    }],
  };
}

function modelMessage(
  id: string,
  stepId: string,
  parts: AssistantSessionPart[],
  createdAt: number,
  outputPhase: "commentary" | "final_answer" = "commentary",
): SessionMessage {
  return {
    id,
    role: "assistant",
    executionId: "execution",
    runOrdinal: 0,
    stepId,
    outputPhase,
    parts,
    createdAt,
    completedAt: createdAt,
  };
}

function modelOutput(
  id: string,
  text: string,
  createdAt: number,
): AssistantSessionPart {
  return {
    type: "assistant-output",
    id,
    blockId: id,
    text,
    createdAt,
    completedAt: createdAt,
  };
}

function runningTool(id: string, path: string, createdAt: number): AssistantSessionPart {
  return {
    type: "tool",
    id,
    state: "running",
    toolCallId: `call:${id}`,
    toolName: "file_read",
    input: { path },
    createdAt,
    startedAt: createdAt,
  };
}

function reasoningPart(
  id: string,
  text: string,
  createdAt: number,
): AssistantSessionPart {
  return {
    type: "reasoning",
    id,
    blockId: id,
    text,
    createdAt,
    completedAt: createdAt,
  };
}

function usageStep(
  id: string,
  startedAt: number,
  reasoningTokens: number,
): SessionStep {
  return {
    id,
    executionId: "execution",
    runOrdinal: 0,
    step: startedAt,
    startedAt,
    completedAt: startedAt + 1,
    finishReason: "tool-calls",
    usage: { ...usage, reasoningTokens },
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
      .applyAuthoritativeSnapshot(sessionAuthoritativeSnapshot("session", {
        rootSessionId: "session",
        agentName: "lead",
        eventCursor: -1,
        messages,
        executions: [execution],
        steps,
      }), currentSessionSnapshotGeneration());
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
  test("renders commentary and tools in exact Work order with per-attempt token-only Reasoning", async () => {
    await render(
      [
        message("input", "user", "Inspect", 5),
        modelMessage("attempt-1", "step-1", [
          modelOutput("commentary-1", "First commentary", 10),
          runningTool("tool-1", "one.ts", 11),
        ], 10),
        modelMessage("attempt-2", "step-2", [
          modelOutput("commentary-2", "Second commentary", 20),
          runningTool("tool-2", "two.ts", 21),
        ], 20),
        modelMessage("final", "step-3", [
          modelOutput("final-output", "Done", 90),
        ], 90, "final_answer"),
      ],
      completed(),
      [
        usageStep("step-1", 10, 137),
        usageStep("step-2", 20, 56),
        { ...usageStep("step-3", 90, 0), finishReason: "stop" },
      ],
    );
    const segmentId = "work:execution:after:input";
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        `[data-testid="work-summary-${segmentId}"]`,
      )?.click();
    });
    const body = container.querySelector(`[id="work-body-${segmentId}"]`);
    const bodyText = body?.textContent ?? "";
    const usageRows = Array.from(
      body?.querySelectorAll('[data-testid="reasoning-usage-summary"]') ?? [],
    );

    expect(usageRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("137 tokens"),
      expect.stringContaining("56 tokens"),
    ]);
    expect(bodyText).not.toContain("193");
    expect(bodyText.indexOf("137 tokens")).toBeLessThan(
      bodyText.indexOf("First commentary"),
    );
    expect(bodyText.indexOf("First commentary")).toBeLessThan(
      bodyText.indexOf("one.ts"),
    );
    expect(bodyText.indexOf("one.ts")).toBeLessThan(
      bodyText.indexOf("56 tokens"),
    );
    expect(bodyText.indexOf("56 tokens")).toBeLessThan(
      bodyText.indexOf("Second commentary"),
    );
    expect(bodyText.indexOf("Second commentary")).toBeLessThan(
      bodyText.indexOf("two.ts"),
    );
    expect(
      container.querySelector('[data-testid="final-response-execution"]')
        ?.textContent,
    ).toContain("Done");
  });

  test("renders multiple Reasoning blocks independently without a token placeholder", async () => {
    await render(
      [
        modelMessage("attempt", "step-1", [
          reasoningPart("reason-a", "First reasoning", 10),
          modelOutput("commentary", "Between", 11),
          reasoningPart("reason-b", "Second reasoning", 12),
        ], 10),
      ],
      completed(),
      [usageStep("step-1", 10, 193)],
    );
    const segmentId = "work:execution:implicit";
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        `[data-testid="work-summary-${segmentId}"]`,
      )?.click();
    });
    const body = container.querySelector(`[id="work-body-${segmentId}"]`);

    expect(body?.querySelectorAll('[data-testid="reasoning-block"]'))
      .toHaveLength(2);
    expect(body?.querySelector('[data-testid="reasoning-usage-summary"]'))
      .toBeNull();
    expect(body?.textContent).toContain("Between");
  });

  test("renders adjacent canonical UserMessages as independent empty Work Segments", async () => {
    await render(
      [
        message("one", "user", "One", 10),
        message("two", "user", "Two", 11),
      ],
      completed(),
    );

    expect(container.querySelectorAll("[data-work-segment]")).toHaveLength(2);
    expect(
      container.querySelector('[data-work-segment="work:execution:after:one"]')
        ?.textContent,
    ).toContain("One");
    expect(
      container.querySelector('[data-work-segment="work:execution:after:two"]')
        ?.textContent,
    ).toContain("Two");
  });

  test("renders ordered independent Work Segments while final output stays with the last segment", async () => {
    await render(
      [
        message("input", "user", "Initial request", 10),
        message("early", "assistant", "Early work", 20),
        message("steer", "user", "Steer the work", 40),
        message("late", "assistant", "Later work", 50),
        message("final", "assistant", "Done", 90, "final_answer"),
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
    ).not.toContain("Early work");
    expect(
      container.querySelector(`[id="work-body-${first}"]`),
    ).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        `[data-testid="work-summary-${first}"]`,
      )?.click();
    });
    expect(
      container.querySelector(`[id="work-body-${first}"]`)?.textContent,
    ).toContain("Early work");
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
      expect.stringContaining("Initial request"),
      expect.stringContaining("First steer"),
      expect.stringContaining("Second steer"),
      expect.stringContaining("Third steer"),
    ]);
    expect(markers.every((marker) =>
      !marker.getAttribute("aria-label")?.includes("Message ")
    )).toBe(true);

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

  test("moves automatic expansion from the initial implicit Segment to committed input, then folds after final output", async () => {
    const implicit = "work:execution:implicit";
    await render([], running());
    expect(container.querySelector(`[data-testid="work-disclosure-${implicit}"]`)
      ?.getAttribute("data-work-expanded")).toBe("true");

    const input = message("input", "user", "Initial request", 10);
    const latest = "work:execution:after:input";
    await render([input], running());
    expect(container.querySelector(`[data-testid="work-disclosure-${implicit}"]`))
      .toBeNull();
    expect(container.querySelector(`[data-testid="work-disclosure-${latest}"]`)
      ?.getAttribute("data-work-expanded")).toBe("true");

    const final = message(
      "final",
      "assistant",
      "Done",
      90,
      "final_answer",
    );
    await render([input, final], completed(), [
      {
        id: "step",
        executionId: "execution",
        runOrdinal: 0,
        step: 1,
        startedAt: 80,
        completedAt: 90,
        finishReason: "stop",
      },
    ]);
    expect(container.querySelector(`[data-testid="work-disclosure-${latest}"]`)
      ?.getAttribute("data-work-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="final-response-execution"]')
      ?.textContent).toContain("Done");
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
