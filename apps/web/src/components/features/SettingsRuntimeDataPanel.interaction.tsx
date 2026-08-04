import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.PointerEvent ?? dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function inspectionResponse() {
  return {
    projects: [{
      projectSlug: "broken",
      name: "Broken",
      workspace: "/work/broken",
      runtimePath: "/work/broken/.archcode/runtime",
      stats: { fileCount: 4, totalBytes: 2048 },
      issues: [{ relativePath: "todos/state.json", reason: "invalid_json" }],
    }],
  };
}

async function renderPanel(onRefreshRuntime = async () => {}) {
  const { SettingsRuntimeDataPanel } = await import("./SettingsRuntimeDataPanel");
  await act(async () => {
    root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Runtime failed safely", recoveryAllowed: true } }} onRefreshRuntime={onRefreshRuntime} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Delete runtime data")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Settings Runtime Data interactions", () => {
  test("cancels the irreversible confirmation without deleting", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method });
      return Response.json(inspectionResponse());
    }) });

    await renderPanel();

    expect(document.body.textContent).toContain("Permanently delete Runtime data?");
    expect(document.body.textContent).toContain("Sessions, Todos, Automations, HITL requests, permissions, attachments, and project memory");
    expect(document.body.textContent).toContain("~/.archcode/config.json");
    act(() => [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());

    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Permanently delete Runtime data?");
  });

  test("prevents duplicate deletion and announces a per-project failure", async () => {
    let resolveDelete!: (response: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (init?.method === "DELETE") return pendingDelete;
      return Response.json(inspectionResponse());
    }) });
    const onRefreshRuntime = mock(async () => {});

    await renderPanel(onRefreshRuntime);
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete permanently") as HTMLButtonElement;
    act(() => confirm.click());
    expect([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Deleting…")?.hasAttribute("disabled")).toBe(true);
    act(() => confirm.click());
    expect(requests.filter((request) => request.init?.method === "DELETE")).toHaveLength(1);
    expect(JSON.parse(String(requests.find((request) => request.init?.method === "DELETE")?.init?.body))).toEqual({ projectSlugs: ["broken"] });

    await act(async () => {
      resolveDelete(Response.json({
        results: [{ projectSlug: "broken", status: "error", error: { code: "delete_failed", message: "Permission denied" } }],
        runtime: { state: "error", error: { message: "Runtime still cannot start", recoveryAllowed: true } },
      }));
      await pendingDelete;
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect([...container.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes("Permission denied"))).toBe(true);
    expect(container.textContent).toContain("Runtime still cannot start");
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.textContent).toBe("Runtime Data");
  });

  test("closes the confirmation and exposes an error when the delete request rejects", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Response.json({ error: { message: "Deletion service unavailable" } }, { status: 500 });
      }
      return Response.json(inspectionResponse());
    }) });

    await renderPanel();
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete permanently") as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(document.body.textContent).not.toContain("Permanently delete Runtime data?");
    expect(container.textContent).toContain("Deletion service unavailable");
    expect(document.activeElement?.textContent).toBe("Runtime Data");
  });

  test("refetches inspection and Bootstrap state after a successful deletion", async () => {
    let inspectionCalls = 0;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (init?.method === "DELETE") {
        return Response.json({
          results: [{ projectSlug: "broken", status: "deleted" }],
          runtime: { state: "ready" },
        });
      }
      inspectionCalls += 1;
      return Response.json(inspectionCalls === 1 ? inspectionResponse() : { projects: [] });
    }) });
    const onRefreshRuntime = mock(async () => {});

    await renderPanel(onRefreshRuntime);
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete permanently") as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(requests.filter((request) => request.init?.method === "DELETE")).toHaveLength(1);
    expect(inspectionCalls).toBe(2);
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Runtime data deleted for 1 project");
    expect(container.textContent).toContain("Runtime is ready");
    expect(container.textContent).toContain("No registered project Runtime data was found");
  });

  test("preserves a successful deletion when the Runtime status refresh fails", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({
        results: [{ projectSlug: "broken", status: "deleted" }],
        runtime: { state: "ready" },
      });
      return Response.json(inspectionResponse());
    }) });
    const onRefreshRuntime = mock(async () => { throw new Error("Runtime status refresh failed."); });

    await renderPanel(onRefreshRuntime);
    await act(async () => {
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete permanently")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(document.body.textContent).not.toContain("Permanently delete Runtime data?");
    expect(container.textContent).toContain("Runtime data deleted for 1 project");
    expect(container.textContent).toContain("Runtime status refresh failed.");
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
  });

  test("preserves a successful Runtime retry when the status refresh fails", async () => {
    const requests: Array<{ method?: string }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      requests.push({ method: init?.method });
      if (init?.method === "POST") return Response.json({ state: "ready" });
      return Response.json(inspectionResponse());
    }) });
    const onRefreshRuntime = mock(async () => { throw new Error("Runtime status refresh failed."); });
    const { SettingsRuntimeDataPanel } = await import("./SettingsRuntimeDataPanel");
    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Runtime failed", recoveryAllowed: true } }} onRefreshRuntime={onRefreshRuntime} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry Runtime")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(container.textContent).toContain("Runtime is ready.");
    expect(container.textContent).toContain("Runtime status refresh failed.");
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
  });

  test("shows the final Runtime error returned by deletion without waiting for Bootstrap refresh", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({
        results: [{ projectSlug: "broken", status: "deleted" }],
        runtime: { state: "error", error: { message: "Final Runtime activation failed", recoveryAllowed: true } },
      });
      return Response.json(inspectionResponse());
    }) });
    const onRefreshRuntime = mock(async () => {});

    await renderPanel(onRefreshRuntime);
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete permanently") as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Runtime could not start");
    expect(container.textContent).toContain("Final Runtime activation failed");
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
  });
});
