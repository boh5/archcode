import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { DiffTab } from "./DiffTab";
import { sessionRuntimeStore } from "../../store/session-runtime-store";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
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

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (error) { lastError = error; }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw lastError;
}

afterEach(() => {
  sessionRuntimeStore.getState().reset();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  mock.restore();
});

describe("DiffTab live refresh", () => {
  test("performs a final refresh when the Session family becomes idle", async () => {
    const dom = installDom();
    let requests = 0;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => {
      requests += 1;
      return Response.json({ files: [{ path: `src/revision-${requests}.ts`, status: "modified", additions: 1, deletions: 0, hunks: [] }] });
    }) });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "root", activity: "running" }],
      createdAt: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <DiffTab slug="demo" sessionId="root" />
      </QueryClientProvider>,
    ));
    await waitFor(() => expect(document.body.textContent).toContain("revision-1"));

    await act(async () => sessionRuntimeStore.getState().applyChange({
      type: "session.runtime_changed",
      projectSlug: "demo",
      rootSessionId: "root",
      activity: "idle",
      createdAt: 2,
    }));
    await waitFor(() => expect(document.body.textContent).toContain("revision-2"));
    expect(requests).toBe(2);

    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  });

  test("refreshes on remount after an execution finished while the Diff was hidden", async () => {
    const dom = installDom();
    let requests = 0;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => {
      requests += 1;
      return Response.json({ files: [{ path: `src/remount-${requests}.ts`, status: "modified", additions: 1, deletions: 0, hunks: [] }] });
    }) });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [],
      createdAt: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const container = document.getElementById("root")!;
    const firstRoot = createRoot(container);
    await act(async () => firstRoot.render(
      <QueryClientProvider client={client}>
        <DiffTab slug="demo" sessionId="root" />
      </QueryClientProvider>,
    ));
    await waitFor(() => expect(container.textContent).toContain("remount-1"));
    await act(async () => firstRoot.unmount());

    sessionRuntimeStore.getState().applyChange({ type: "session.runtime_changed", projectSlug: "demo", rootSessionId: "root", activity: "running", createdAt: 2 });
    sessionRuntimeStore.getState().applyChange({ type: "session.runtime_changed", projectSlug: "demo", rootSessionId: "root", activity: "idle", createdAt: 3 });

    const secondRoot = createRoot(container);
    await act(async () => secondRoot.render(
      <QueryClientProvider client={client}>
        <DiffTab slug="demo" sessionId="root" />
      </QueryClientProvider>,
    ));
    await waitFor(() => expect(container.textContent).toContain("remount-2"));
    expect(requests).toBe(2);

    await act(async () => secondRoot.unmount());
    client.clear();
    dom.window.close();
  });
});
