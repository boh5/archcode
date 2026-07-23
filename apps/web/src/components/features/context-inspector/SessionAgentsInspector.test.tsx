import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { SessionTreeNode, SessionTreeResponse, ToolChildSessionLink } from "@archcode/protocol";
import type { Session } from "../../../api/types";
import { queryKeys } from "../../../api/queries";
import { __resetWebSessionStoresForTest, getWebSessionStore } from "../../../store/session-store";
import { SessionAgentsInspector } from "./SessionAgentsInspector";

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
  __resetWebSessionStoresForTest();
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
  children?: SessionTreeNode[];
}): SessionTreeNode {
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
    children: input.children ?? [],
  };
}

function link(input: {
  parentSessionId: string;
  childSessionId: string;
  status: ToolChildSessionLink["status"];
  childAgentName: string;
  childProfile: "deep" | "fast";
  depth: number;
}): ToolChildSessionLink {
  return {
    parentSessionId: input.parentSessionId,
    parentToolCallId: `delegate-${input.childSessionId}`,
    toolName: "delegate",
    childSessionId: input.childSessionId,
    childAgentName: input.childAgentName,
    childProfile: input.childProfile,
    childSkillNames: [],
    title: input.childSessionId,
    depth: input.depth,
    background: false,
    status: input.status,
    createdAt: 1,
  };
}

afterEach(restoreDom);

describe("SessionAgentsInspector", () => {
  test("renders a grandchild status from the direct parent's authoritative Session snapshot", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const rootLink = link({
      parentSessionId: "root",
      childSessionId: "child",
      status: "completed",
      childAgentName: "build",
      childProfile: "deep",
      depth: 1,
    });
    const grandchildLink = link({
      parentSessionId: "child",
      childSessionId: "grandchild",
      status: "waiting_for_human",
      childAgentName: "explore",
      childProfile: "fast",
      depth: 2,
    });
    const tree: SessionTreeResponse = {
      root: node({
        sessionId: "root",
        agentName: "lead",
        profile: "principal",
        children: [node({
          sessionId: "child",
          parentSessionId: "root",
          agentName: "build",
          profile: "deep",
          children: [node({
            sessionId: "grandchild",
            parentSessionId: "child",
            agentName: "explore",
            profile: "fast",
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
    queryClient.setQueryData(queryKeys.session("demo", "child"), {
      sessionId: "child",
      childSessionLinks: [grandchildLink],
    } as Session);
    getWebSessionStore("root", "demo").getState().initializeFromSnapshot({
      childSessionLinks: [rootLink],
    });

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/demo/sessions/root"]}>
          <Routes>
            <Route path="/projects/:slug/sessions/:sessionId" element={<SessionAgentsInspector />} />
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
    expect(rows[2]?.querySelector('[data-agent-status="Needs you"]')).not.toBeNull();

    await act(async () => root.unmount());
    queryClient.clear();
    dom.window.close();
  });
});
