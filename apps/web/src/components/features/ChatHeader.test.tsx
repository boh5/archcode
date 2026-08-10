import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ExecutionModelBindingSummary,
  SessionExecutionRecord,
} from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router-dom";
import { ChatHeader } from "./ChatHeader";
import {
  __resetWebSessionStoresForTest,
  getWebSessionStore,
} from "../../store/session-store";
import { WorkbenchLayoutProvider } from "../../context/workbench-layout";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const binding: ExecutionModelBindingSummary = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Test",
  resolution: "profile_default",
  modelRuntimeRevision: "r1",
};
const memoryPolicy = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
};
function suspended(): SessionExecutionRecord {
  return {
    id: "execution",
    memoryPolicy,
    startedAt: 0,
    origin: "user_message",
    maxSteps: 10,
    executionSkills: [],
    durationMs: 1,
    status: "suspended",
    suspension: { kind: "hitl", toolBatchId: "batch", blockerIds: ["hitl"] },
    runs: [
      {
        ordinal: 0,
        startedAt: 0,
        endedAt: 1,
        durationMs: 1,
        binding,
        usageDelta: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
        settlement: { key: "run", goalInstanceId: null },
      },
    ],
  };
}
beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
});
afterEach(() => {
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  dom.window.close();
});
describe("ChatHeader", () => {
  test("presents suspended HITL directly from the Execution record", async () => {
    getWebSessionStore("session", "demo").setState({
      title: "Review",
      executions: [suspended()],
      currentExecutionId: "execution",
    });
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WorkbenchLayoutProvider>
            <ChatHeader
              slug="demo"
              sessionId="session"
              source={{
                label: "Todo",
                title: "Review session context",
                to: "/projects/demo/todos/todo-1",
                usesLiveTodoReferences: true,
              }}
              inspectorExpanded={false}
              onToggleInspector={() => {}}
            />
          </WorkbenchLayoutProvider>
        </MemoryRouter>,
      ),
    );
    const status = container.querySelector(
      '[data-testid="session-execution-status"]',
    );
    expect(status?.textContent).toContain("Needs you");
    expect(status?.getAttribute("data-product-status")).toBe("needs_you");
    const source = container.querySelector('[data-testid="session-source"]');
    expect(source?.className).not.toContain("max-[760px]:hidden");
    expect(source?.querySelector("a")?.getAttribute("href")).toBe("/projects/demo/todos/todo-1");
    expect(container.querySelector('[data-testid="session-source-annotation"]')?.className).toContain("max-[760px]:hidden");
    const inspectorButton = container.querySelector('header button[aria-label="Expand context inspector"]');
    expect(inspectorButton).not.toBeNull();
    expect(inspectorButton?.className).not.toContain("max-[760px]:hidden");
  });
});
