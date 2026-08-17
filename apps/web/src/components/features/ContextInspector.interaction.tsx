import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { JSDOM } from "jsdom";
import type { SessionTreeResponse } from "../../api/types";

const originals = new Map<string, PropertyDescriptor | undefined>();

mock.module("./context-inspector/SessionInspector", () => ({
  SessionInspector: ({ activeTab }: { activeTab: string }) => <div data-testid="active-panel">{activeTab}</div>,
}));

const treeResponse: SessionTreeResponse = {
  root: {
    session: {
      sessionId: "root",
      rootSessionId: "root",
      cwd: "/workspace/demo",
      agentName: "lead",
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: "Root session",
      source: { kind: "direct" },
      createdAt: 1,
      updatedAt: 2,
    },
    children: [{
      session: {
        sessionId: "child",
        rootSessionId: "root",
        parentSessionId: "root",
        cwd: "/workspace/demo",
        agentName: "build",
        profile: "deep",
        activeSkillNames: [],
        modelSelection: { revision: 0 },
        title: "Build child",
        createdAt: 1,
        updatedAt: 2,
      },
      children: [],
    }],
  },
  diagnostics: [],
};

const apiFetch = mock(async (path: string): Promise<unknown> => {
  if (path === "/api/projects/demo/sessions/root/tree") return treeResponse;
  if (path === "/api/projects/demo/diff?sessionId=root") {
    return { files: [{ path: "src/index.ts", status: "modified", additions: 2, deletions: 1 }] };
  }
  throw new Error(`Unexpected Inspector request: ${path}`);
});

mock.module("../../api/client", () => ({ apiFetch }));

const { ContextInspector } = await import("./ContextInspector");

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
    KeyboardEvent: dom.window.KeyboardEvent,
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

afterEach(restoreDom);

describe("ContextInspector keyboard tabs", () => {
  test("supports ArrowLeft/ArrowRight/Home/End while keeping focus and URL state aligned", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiFetch.mockClear();
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/demo/sessions/root"]}>
          <Routes>
            <Route path="/projects/:slug/sessions/:sessionId" element={<ContextInspector kind="session" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((element) => element.textContent?.startsWith(label))!;
    const key = async (target: HTMLButtonElement, value: string) => {
      target.focus();
      await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
      })));
    };

    expect(container.querySelector('[data-testid="inspector-count-agents"]')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="inspector-count-changes"]')?.textContent).toBe("1");
    expect(apiFetch).toHaveBeenCalledWith("/api/projects/demo/sessions/root/tree");
    expect(apiFetch).toHaveBeenCalledWith("/api/projects/demo/diff?sessionId=root");
    expect(tab("Agents").getAttribute("aria-selected")).toBe("true");
    await key(tab("Agents"), "ArrowRight");
    expect(tab("Changes").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Changes"));
    expect(container.querySelector('[data-testid="active-panel"]')?.textContent).toBe("changes");

    await key(tab("Changes"), "End");
    expect(tab("Context").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Context"));

    await key(tab("Context"), "Home");
    expect(tab("Agents").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Agents"));

    await key(tab("Agents"), "ArrowLeft");
    expect(tab("Context").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Context"));

    await act(async () => root.unmount());
    queryClient.clear();
    dom.window.close();
  });
});
