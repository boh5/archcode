import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { AgentTreeNode, AgentTreeProjection } from "@archcode/protocol";
import { queryKeys } from "../../../api/queries";
import { SessionAgentsInspector } from "./SessionAgentsInspector";
import { flattenInspectorAgents } from "./session-inspector-projection";
import { sessionRuntimeStore } from "../../../store/session-runtime-store";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/projects/demo/sessions/root",
  });
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

function node(input: {
  sessionId: string;
  parentSessionId?: string;
  agentName: string;
  profile: "principal" | "deep" | "fast";
  depth: number;
  latestExecutionStatus: AgentTreeNode["latestExecutionStatus"];
  activeExecutionId?: string | null;
  linkStatus?: AgentTreeNode["linkStatus"];
  children?: AgentTreeNode[];
}): AgentTreeNode {
  return {
    session: {
      sessionId: input.sessionId,
      cwd: "/workspace",
      rootSessionId: "root",
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      agentName: input.agentName,
      profile: input.profile,
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: input.sessionId,
      createdAt: 1,
      updatedAt: 2,
    },
    depth: input.depth,
    latestExecutionStatus: input.latestExecutionStatus,
    activeExecutionId: input.activeExecutionId ?? null,
    linkStatus: input.linkStatus ?? null,
    children: input.children ?? [],
  };
}

afterEach(() => {
  restoreDom();
  sessionRuntimeStore.getState().reset();
});

describe("SessionAgentsInspector", () => {
  test("renders all descendant statuses directly from the canonical Agent Tree projection", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const tree: AgentTreeProjection = {
      root: node({
        sessionId: "root",
        agentName: "lead",
        profile: "principal",
        depth: 0,
        latestExecutionStatus: "running",
        activeExecutionId: "root-execution",
        children: [node({
          sessionId: "child",
          parentSessionId: "root",
          agentName: "build",
          profile: "deep",
          depth: 1,
          latestExecutionStatus: "completed",
          linkStatus: "completed",
          children: [node({
            sessionId: "grandchild",
            parentSessionId: "child",
            agentName: "explore",
            profile: "fast",
            depth: 2,
            latestExecutionStatus: "suspended",
            linkStatus: "waiting_for_human",
          })],
        })],
      }),
      diagnostics: [],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    queryClient.setQueryData(queryKeys.tree("demo", "root"), tree);
    queryClient.setQueryData(queryKeys.agents, [
      { name: "lead", displayName: "Lead" },
      { name: "build", displayName: "Build" },
      { name: "explore", displayName: "Explore" },
    ]);

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/demo/sessions/root"]}>
          <Routes>
            <Route path="/projects/:slug/sessions/:sessionId" element={<SessionAgentsInspector projection={{ items: flattenInspectorAgents(tree.root), isLoading: false, error: null }} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Agents"] > button'));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("root"),
      expect.stringContaining("child"),
      expect.stringContaining("grandchild"),
    ]);
    expect(rows[0]?.textContent).toContain("Lead");
    expect(rows[1]?.textContent).toContain("Build");
    expect(rows[2]?.textContent).toContain("Explore");
    expect(rows[0]?.querySelector('[data-agent-role-icon="lead"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-agent-role-icon="build"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-agent-role-icon="explore"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-agent-status="Completed"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-agent-status="Paused"]')).not.toBeNull();
    expect(queryClient.getQueryData(queryKeys.session("demo", "child"))).toBeUndefined();

    await act(async () => root.unmount());
    queryClient.clear();
    dom.window.close();
  });

  test("keeps canonical root activity and child terminal status on a child Session route", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const tree: AgentTreeProjection = {
      root: node({
        sessionId: "root",
        agentName: "lead",
        profile: "principal",
        depth: 0,
        latestExecutionStatus: "running",
        activeExecutionId: "root-execution",
        children: [node({
          sessionId: "child",
          parentSessionId: "root",
          agentName: "build",
          profile: "deep",
          depth: 1,
          latestExecutionStatus: "cancelled",
          linkStatus: "cancelled",
        })],
      }),
      diagnostics: [],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    queryClient.setQueryData(queryKeys.agents, [
      { name: "lead", displayName: "Lead" },
      { name: "build", displayName: "Build" },
    ]);
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "root", activity: "running" }],
      createdAt: 1,
    });

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/demo/sessions/child"]}>
          <Routes>
            <Route path="/projects/:slug/sessions/:sessionId" element={<SessionAgentsInspector projection={{ items: flattenInspectorAgents(tree.root), isLoading: false, error: null }} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Agents"] > button'));
    expect(rows[0]?.querySelector('[data-agent-status="Running"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-agent-status="Stopped"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-agent-status="Stopped"]')?.getAttribute("title")).toContain("Cancelled");

    await act(async () => root.unmount());
    queryClient.clear();
    dom.window.close();
  });
});
