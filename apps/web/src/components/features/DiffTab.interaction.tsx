import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { DiffTab } from "./DiffTab";
import { sessionRuntimeStore } from "../../store/session-runtime-store";
import { diffQueryOptions } from "../../api/queries";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  notifyManager.setScheduler((callback) => callback());
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return dom;
}

function controlledDiffFetch(revisions: string[]) {
  const responses = revisions.map(() => Promise.withResolvers<Response>());
  const requested = revisions.map(() => Promise.withResolvers<void>());
  let requests = 0;
  const fetch = mock(async () => {
    const index = requests++;
    requested[index]?.resolve();
    const response = responses[index];
    if (response === undefined) throw new Error(`Unexpected Diff request ${requests}`);
    return await response.promise;
  });
  return { fetch, requested, responses, requestCount: () => requests };
}

afterEach(() => {
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  sessionRuntimeStore.getState().reset();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  mock.restore();
});

describe("DiffTab live refresh", () => {
  test("keeps the aggregate Diff and reveals the file selected from Changes", async () => {
    const dom = installDom();
    const scrollIntoView = mock(() => {});
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const diffFetch = controlledDiffFetch(["selected-file"]);
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: diffFetch.fetch });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(document.getElementById("root")!);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DiffTab slug="demo" sessionId="root" selectedPath="src/second.ts" />
        </QueryClientProvider>,
      );
    });
    await diffFetch.requested[0].promise;
    await act(async () => {
      diffFetch.responses[0].resolve(Response.json({
        files: [
          { path: "src/first.ts", status: "modified", additions: 2, deletions: 1, hunks: [] },
          { path: "src/second.ts", status: "modified", additions: 3, deletions: 2, hunks: [] },
          { path: "src/third.ts", status: "created", additions: 5, deletions: 0, hunks: [] },
        ],
      }));
      await client.fetchQuery({ ...diffQueryOptions("demo", "root"), staleTime: Infinity });
    });

    expect(document.querySelector("[data-session-diff-heading]")?.textContent).toBe("3 files changed");
    expect(document.body.textContent).toContain("+10");
    expect(document.body.textContent).toContain("−3");
    expect(document.querySelectorAll("[data-diff-file]")).toHaveLength(3);
    const selected = document.querySelector<HTMLButtonElement>('[data-diff-file="src/second.ts"] > button');
    expect(selected?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(selected);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DiffTab slug="demo" sessionId="root" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DiffTab slug="demo" sessionId="root" selectedPath="src/second.ts" />
        </QueryClientProvider>,
      );
    });
    expect(document.activeElement).toBe(selected);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  });

  test("performs a final refresh when the Session family becomes idle", async () => {
    const dom = installDom();
    const diffFetch = controlledDiffFetch(["revision-1", "revision-2"]);
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: diffFetch.fetch });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "root", activity: "running" }],
      createdAt: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DiffTab slug="demo" sessionId="root" />
        </QueryClientProvider>,
      );
    });
    await diffFetch.requested[0].promise;
    await act(async () => {
      diffFetch.responses[0].resolve(Response.json({
        files: [{ path: "src/revision-1.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
      }));
      await client.fetchQuery({ ...diffQueryOptions("demo", "root"), staleTime: Infinity });
    });
    expect(document.body.textContent).toContain("revision-1");

    await act(async () => {
      sessionRuntimeStore.getState().applyChange({
        type: "session.runtime_changed",
        projectSlug: "demo",
        rootSessionId: "root",
        activity: "idle",
        createdAt: 2,
      });
    });
    await diffFetch.requested[1].promise;
    await act(async () => {
      diffFetch.responses[1].resolve(Response.json({
        files: [{ path: "src/revision-2.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
      }));
      await client.fetchQuery({ ...diffQueryOptions("demo", "root"), staleTime: Infinity });
    });
    expect(document.body.textContent).toContain("revision-2");
    expect(diffFetch.requestCount()).toBe(2);

    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  });

  test("refreshes on remount after an execution finished while the Diff was hidden", async () => {
    const dom = installDom();
    const diffFetch = controlledDiffFetch(["remount-1", "remount-2"]);
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: diffFetch.fetch });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [],
      createdAt: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const container = document.getElementById("root")!;
    const firstRoot = createRoot(container);
    await act(async () => {
      firstRoot.render(
        <QueryClientProvider client={client}>
          <DiffTab slug="demo" sessionId="root" />
        </QueryClientProvider>,
      );
    });
    await diffFetch.requested[0].promise;
    await act(async () => {
      diffFetch.responses[0].resolve(Response.json({
        files: [{ path: "src/remount-1.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
      }));
      await client.fetchQuery({ ...diffQueryOptions("demo", "root"), staleTime: Infinity });
    });
    expect(container.textContent).toContain("remount-1");
    await act(async () => firstRoot.unmount());

    sessionRuntimeStore.getState().applyChange({ type: "session.runtime_changed", projectSlug: "demo", rootSessionId: "root", activity: "running", createdAt: 2 });
    sessionRuntimeStore.getState().applyChange({ type: "session.runtime_changed", projectSlug: "demo", rootSessionId: "root", activity: "idle", createdAt: 3 });

    const secondRoot = createRoot(container);
    await act(async () => {
      secondRoot.render(
        <QueryClientProvider client={client}>
          <DiffTab slug="demo" sessionId="root" />
        </QueryClientProvider>,
      );
    });
    await diffFetch.requested[1].promise;
    await act(async () => {
      diffFetch.responses[1].resolve(Response.json({
        files: [{ path: "src/remount-2.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
      }));
      await client.fetchQuery({ ...diffQueryOptions("demo", "root"), staleTime: Infinity });
    });
    expect(container.textContent).toContain("remount-2");
    expect(diffFetch.requestCount()).toBe(2);

    await act(async () => secondRoot.unmount());
    client.clear();
    dom.window.close();
  });
});
