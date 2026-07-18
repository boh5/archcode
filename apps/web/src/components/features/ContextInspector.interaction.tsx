import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { ContextInspector } from "./ContextInspector";
import { WorkbenchLayoutProvider, useCloseMobileSurfacesOnNavigation, useWorkbenchLayout } from "../../context/workbench-layout";
import type { Automation, GoalState, Session, SessionTreeResponse } from "../../api/types";
import { createEmptySessionStats } from "@archcode/protocol";
import { __resetWebSessionStoresForTest, getWebSessionStore } from "../../store/session-store";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(path: string): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `http://localhost${path}` });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return dom;
}

function restoreDom(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (error) { lastError = error; }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw lastError;
}

async function renderInspector(root: Root, path: string, kind: "session" | "goal") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    root.render(
      <WorkbenchLayoutProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/projects/:slug/sessions/:sessionId" element={<><ContextInspector id="mobile-context-inspector" kind={kind} onCollapse={collapseInspector} /><LocationProbe /><LayoutProbe /></>} />
              <Route path="/projects/:slug/goals/:goalId" element={<ContextInspector kind={kind} onCollapse={collapseInspector} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </WorkbenchLayoutProvider>,
    );
  });
  return client;
}

const collapseInspector = mock(() => {});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function LayoutProbe() {
  const layout = useWorkbenchLayout();
  const location = useLocation();
  useCloseMobileSurfacesOnNavigation(`${location.pathname}${location.search}`);
  useEffect(() => layout.setMobileInspectorOpen(true), []);
  return (
    <>
      <output data-testid="mobile-inspector-open">{String(layout.mobileInspectorOpen)}</output>
      <button type="button" data-testid="reopen-mobile-inspector" onClick={() => layout.setMobileInspectorOpen(true)}>Reopen inspector</button>
    </>
  );
}

afterEach(() => {
  __resetWebSessionStoresForTest();
  restoreDom();
  mock.restore();
});

describe("ContextInspector interactions", () => {
  test("organizes Session agents, changed files, and context from real APIs", async () => {
    const dom = installDom("/projects/demo/sessions/root");
    const session: Session = {
      sessionId: "root", rootSessionId: "root", cwd: "/workspace/demo", title: "Root execution",
      createdAt: 1, updatedAt: 2, agentName: "engineer", activeSkillNames: [], modelInfo: null, messages: [], pendingMessages: [], steps: [], todos: [], reminders: [], childSessionLinks: [], childResultReceipts: [], executions: [], stats: createEmptySessionStats(),
    };
    const childSession: Session = {
      ...session,
      sessionId: "child",
      rootSessionId: "root",
      parentSessionId: "root",
      cwd: "/workspace/demo-child",
      title: "Build agent",
      agentName: "build",
      goalId: "executing-goal",
      modelInfo: { providerId: "openai", modelId: "gpt-5", qualifiedId: "openai:gpt-5", displayName: "GPT-5" },
      stats: { ...createEmptySessionStats(), messages: { total: 4, user: 1, assistant: 3 }, tools: { calls: 2, completed: 2, failed: 0 } },
    };
    const relatedGoal: GoalState = {
      id: "created-goal",
      projectSlug: "demo",
      createdFromSessionId: "child",
      title: "Created Goal",
      objective: "Ship the related Goal",
      acceptanceCriteria: "The Goal is verifiably complete",
      useWorktree: false,
      status: "running",
      attempt: 1,
      reviewGeneration: 0,
      appliedBudgetHitlIds: [],
      mainSessionId: "goal-main",
      childSessionIds: [],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      startedAt: "2026-07-13T00:00:00.000Z",
    };
    const relatedAutomation: Automation = {
      id: "22222222-2222-4222-8222-222222222222",
      projectSlug: "demo",
      createdFromSessionId: "child",
      name: "Created Automation",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: { kind: "start_session", message: "Run checks", location: "project" },
      status: "active",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      nextFireAt: "2026-07-13T01:00:00.000Z",
    };
    const tree: SessionTreeResponse = {
      root: { session: { sessionId: "root", rootSessionId: "root", cwd: session.cwd, title: session.title, createdAt: 1, updatedAt: 2, agentName: "engineer", activeSkillNames: [], modelInfo: null }, children: [
        { session: { sessionId: "child", rootSessionId: "root", parentSessionId: "root", cwd: session.cwd, title: "Build agent", createdAt: 1, updatedAt: 2, agentName: "build", activeSkillNames: [], modelInfo: null }, children: [
          { session: { sessionId: "custom", rootSessionId: "root", parentSessionId: "child", cwd: session.cwd, title: "Custom agent", createdAt: 1, updatedAt: 2, agentName: "custom_agent", activeSkillNames: [], modelInfo: null }, children: [] },
        ] },
      ] }, diagnostics: [],
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/agents") return Response.json({ agents: [
        { name: "engineer", displayName: "Engineer" },
        { name: "build", displayName: "Build" },
      ] });
      if (url.endsWith("/goals")) return Response.json({ goals: [relatedGoal] });
      if (url.endsWith("/automations")) return Response.json({ automations: [relatedAutomation] });
      if (url.endsWith("/tree")) return Response.json(tree);
      if (url.includes("/diff")) return Response.json({ files: [{ path: "src/app.ts", status: "modified", additions: 2, deletions: 1, hunks: [] }] });
      if (url.endsWith("/sessions/child")) return Response.json(childSession);
      if (url.endsWith("/sessions/root")) return Response.json(session);
      return new Response("not found", { status: 404 });
    }) });
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const client = await renderInspector(root, "/projects/demo/sessions/root", "session");
    try {
      await waitFor(() => expect(container.textContent).toContain("Build agent"));
      expect(container.textContent).toContain("Engineer");
      expect(container.textContent).toContain("Build");
      expect(container.textContent).toContain("custom_agent");
      expect(container.querySelector('button[aria-label="Close context inspector"]')).toBeNull();
      const mediumCollapse = container.querySelector('button[aria-label="Collapse context inspector from overlay"]') as HTMLButtonElement;
      expect(mediumCollapse).not.toBeNull();
      expect(container.querySelector("#mobile-context-inspector header")?.className).toContain("max-[799px]:pl-12");
      await act(async () => mediumCollapse.click());
      expect(collapseInspector).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="mobile-inspector-open"]')?.textContent).toBe("true");
      await act(async () => { (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Build agent")) as HTMLButtonElement).click(); });
      await waitFor(() => {
        expect(container.querySelector('[data-testid="location-search"]')?.textContent).toContain("focus=child");
        expect(container.querySelector('[data-testid="mobile-inspector-open"]')?.textContent).toBe("false");
      });
      await act(async () => { (Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Context") as HTMLButtonElement).click(); });
      await waitFor(() => {
        expect(container.textContent).toContain("/workspace/demo-child");
        expect(container.textContent).toContain("GPT-5");
        expect(container.textContent).toContain("Executing Goal");
        expect(container.textContent).toContain("Related work");
        expect(container.textContent).toContain("Created here");
        expect(container.textContent).toContain("Created Goal");
        expect(container.textContent).toContain("Goal · running");
        expect(container.textContent).toContain("Created Automation");
        expect(container.textContent).toContain("Automation · active");
        expect(container.textContent).toContain("next");
      });
      expect(container.querySelector('a[href="/projects/demo/goals/executing-goal"]')).not.toBeNull();
      const createdGoalLink = container.querySelector('a[href="/projects/demo/goals/created-goal"]') as HTMLAnchorElement;
      const createdAutomationLink = container.querySelector('a[href="/projects/demo/automations/22222222-2222-4222-8222-222222222222"]') as HTMLAnchorElement;
      expect(createdGoalLink).not.toBeNull();
      expect(createdAutomationLink).not.toBeNull();
      createdGoalLink.focus();
      expect(document.activeElement).toBe(createdGoalLink);
      createdAutomationLink.focus();
      expect(document.activeElement).toBe(createdAutomationLink);
      await act(async () => getWebSessionStore("child", "demo").setState({
        hydrationStatus: "hydrated",
        cwd: "/workspace/live-child",
        modelInfo: { providerId: "openai", modelId: "gpt-5-live", qualifiedId: "openai:gpt-5-live", displayName: "GPT-5 Live" },
        stats: { ...createEmptySessionStats(), messages: { total: 9, user: 2, assistant: 7 } },
        executions: [{ id: "live-execution", status: "running", startedAt: 1 }],
      }));
      expect(container.textContent).toContain("/workspace/live-child");
      expect(container.textContent).toContain("GPT-5 Live");
      expect(container.textContent).toContain("9");
      await act(async () => { (Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Changes") as HTMLButtonElement).click(); });
      await waitFor(() => expect(container.textContent).toContain("src/app.ts"));
      expect(container.textContent).toContain("1 files");
      await act(async () => (container.querySelector('[data-testid="reopen-mobile-inspector"]') as HTMLButtonElement).click());
      expect(container.querySelector('[data-testid="mobile-inspector-open"]')?.textContent).toBe("true");
      await act(async () => { (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("src/app.ts")) as HTMLButtonElement).click(); });
      await waitFor(() => {
        const search = container.querySelector('[data-testid="location-search"]')?.textContent ?? "";
        expect(search).toContain("view=diff");
        expect(search).not.toContain("focus=");
        expect(container.querySelector('[data-testid="mobile-inspector-open"]')?.textContent).toBe("false");
      });
    } finally {
      await act(async () => root.unmount()); client.clear(); dom.window.close();
    }
  });

  test("organizes Goal criteria, evidence, and sessions", async () => {
    const dom = installDom("/projects/demo/goals/g1");
    const goal: GoalState = {
      id: "g1", projectSlug: "demo", createdFromSessionId: "origin", title: "Goal", objective: "Ship it", acceptanceCriteria: "Tests pass", useWorktree: true,
      status: "done", attempt: 1, reviewGeneration: 1, appliedBudgetHitlIds: [], mainSessionId: "main", childSessionIds: ["child"],
      budget: { status: "warning", usedTokens: 1200, maxTokens: 2000, reason: "Near limit", updatedAt: "2026-01-01" },
      worktree: { path: "/workspace/goal", branchName: "codex/goal", baseSha: "abc123", createdAt: "2026-01-01" },
      review: {
        executionId: "review-exec-1",
        delegationContractHash: "review-contract-1",
        reviewGeneration: 1,
        verdict: "DONE",
        summary: "Verified",
        evidenceRefs: [{ kind: "test_output", ref: "test-1", summary: "All tests passed", sessionId: "main", path: "logs/test.txt", toolCallId: "tool-1", messageId: "message-1", url: "https://example.com/evidence", createdAt: "2026-01-01" }],
        reviewerSessionId: "reviewer",
        decidedAt: "2026-01-01",
        result: { status: "completed", summary: "Verified", deliverables: [], evidence: [], criteria: [], verification: [], unresolved: [] },
      },
      createdAt: "2026-01-01", updatedAt: "2026-01-01", startedAt: "2026-01-01",
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json(goal)) });
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const client = await renderInspector(root, "/projects/demo/goals/g1", "goal");
    try {
      await waitFor(() => expect(container.textContent).toContain("Tests pass"));
      expect(container.textContent).toContain("1,200");
      expect(container.textContent).toContain("codex/goal");
      expect(container.textContent).toContain("done");
      const criteriaTab = Array.from(container.querySelectorAll('[role="tab"]')).find((button) => button.textContent === "Criteria") as HTMLButtonElement;
      expect(criteriaTab.getAttribute("aria-controls")).toBe("context-inspector-panel");
      await act(async () => { criteriaTab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
      expect((Array.from(container.querySelectorAll('[role="tab"]')).find((button) => button.textContent === "Evidence") as HTMLButtonElement).getAttribute("aria-selected")).toBe("true");
      expect(container.textContent).toContain("All tests passed");
      expect(container.textContent).toContain("Decided");
      expect(container.textContent).toContain("logs/test.txt");
      expect(container.querySelector('a[href="/projects/demo/sessions/main"]')).not.toBeNull();
      expect(container.querySelector('a[href="https://example.com/evidence"]')).not.toBeNull();
      await act(async () => { (Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Sessions") as HTMLButtonElement).click(); });
      expect(container.textContent).toContain("main");
      expect(container.textContent).toContain("child");
    } finally {
      await act(async () => root.unmount()); client.clear(); dom.window.close();
    }
  });
});
