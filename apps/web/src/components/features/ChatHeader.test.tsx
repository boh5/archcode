import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ExecutionModelBindingSummary, SessionExecutionRecord } from "@archcode/protocol";
import type { SessionGoalView } from "../../api/types";
import { __resetWebSessionStoresForTest, getWebSessionStore } from "../../store/session-store";
import { ChatHeader } from "./ChatHeader";

const binding: ExecutionModelBindingSummary = {
  selection: { model: "test:model", variant: "deep" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Test Model",
  resolution: "profile_default",
  modelRuntimeRevision: "m1",
};

const goal: SessionGoalView = {
  instanceId: "goal-1",
  generation: 1,
  objective: "Ship the workbench",
  status: "active",
  usage: {
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
    executionTimeMs: 0,
    executionCount: 0,
  },
  createdAt: 1,
  activatedAt: 1,
  updatedAt: 1,
};

function execution(id: string, status: SessionExecutionRecord["status"]): SessionExecutionRecord {
  return { id, status, startedAt: 1, binding, origin: "user_message" };
}

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  __resetWebSessionStoresForTest();
  container = document.getElementById("root")!;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  __resetWebSessionStoresForTest();
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

async function render(onToggleInspector = () => {}): Promise<void> {
  await act(async () => root.render(
    <ChatHeader
      slug="demo"
      sessionId="session"
      goal={goal}
      projectRoot="/workspace"
      inspectorExpanded={false}
      onToggleInspector={onToggleInspector}
    />,
  ));
}

describe("ChatHeader", () => {
  test("shows the current Execution status and its actual model binding", async () => {
    getWebSessionStore("session", "demo").setState({
      title: "Refine Bash policy",
      cwd: "/workspace/.archcode/worktrees/build",
      executions: [execution("current", "running"), execution("newer-record", "completed")],
      currentExecutionId: "current",
    });

    await render();

    expect(container.querySelector("h1")?.textContent).toBe("Refine Bash policy");
    expect(container.querySelector('[data-testid="session-execution-status"]')?.textContent).toContain("Running");
    expect(container.querySelector('[data-testid="session-execution-status"]')?.getAttribute("data-execution-status")).toBe("running");
    expect(container.querySelector('[data-testid="session-execution-meta"]')?.textContent).toBe("Execution 1 · Test Model · deep");
    expect(container.querySelector('[data-testid="goal-status-badge"]')?.textContent).toContain("Active");
    expect(container.querySelector('[data-testid="goal-status-badge"] [data-visual-kind="goal-active"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="session-execution-status"] [data-testid="activity-arc"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="session-worktree-badge"]')?.getAttribute("title")).toBe("/workspace/.archcode/worktrees/build");
  });

  test("falls back to the latest Execution and keeps the Inspector entry available", async () => {
    const store = getWebSessionStore("session", "demo");
    store.setState({
      title: "Review workbench",
      cwd: "/workspace",
      executions: [execution("latest", "waiting_for_human")],
      currentExecutionId: undefined,
    });
    let toggles = 0;

    await render(() => { toggles += 1; });

    const status = container.querySelector('[data-testid="session-execution-status"]');
    expect(status?.textContent).toContain("Needs you");
    expect(status?.getAttribute("data-product-status")).toBe("needs_you");
    expect(status?.getAttribute("data-execution-status")).toBe("waiting_for_human");
    expect(container.querySelector('[data-testid="session-cwd"]')?.textContent).toBe("/workspace");
    expect(container.querySelector('[data-testid="session-worktree-badge"]')).toBeNull();

    const inspector = container.querySelector('button[aria-label="Expand context inspector"]') as HTMLButtonElement;
    expect(inspector).not.toBeNull();
    expect(inspector.className).not.toContain("max-[799px]:hidden");
    await act(async () => inspector.click());
    expect(toggles).toBe(1);

    await act(async () => store.setState({ executions: [execution("latest", "failed")] }));
    expect(container.querySelector('[data-testid="session-execution-status"]')?.textContent).toContain("Stopped");
    expect(container.querySelector('[data-testid="session-execution-status"]')?.textContent).toContain("Failed");
  });

  test("does not present an answered checkpoint as current attention", async () => {
    getWebSessionStore("session", "demo").setState({
      title: "Answered checkpoint",
      cwd: "/workspace",
      executions: [execution("checkpoint", "waiting_for_human")],
      executionInputCheckpoints: [{ executionId: "checkpoint", state: "continued" }],
      currentExecutionId: undefined,
    });

    await render();

    const status = container.querySelector('[data-testid="session-execution-status"]');
    expect(status?.textContent).toContain("Input received");
    expect(status?.textContent).not.toContain("Needs you");
  });
});
