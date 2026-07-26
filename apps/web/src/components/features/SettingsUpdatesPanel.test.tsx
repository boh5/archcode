import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { UpdateStatus } from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SettingsUpdatesPanel } from "./SettingsUpdatesPanel";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

const available: UpdateStatus = {
  currentVersion: "1.0.0",
  phase: "idle",
  managed: true,
  restartSupported: true,
  updateAvailable: true,
  restartRequired: false,
  latest: {
    version: "1.1.0",
    releaseUrl: "https://github.com/boh5/archcode/releases/tag/v1.1.0",
  },
  lastCheckedAt: 1,
};

const restartPending: UpdateStatus = {
  ...available,
  phase: "restart_pending",
  updateAvailable: false,
  restartRequired: true,
};

beforeEach(() => {
  notifyManager.setScheduler((callback) => callback());
  dom = new JSDOM(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>",
    { url: "http://localhost" },
  );
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  container = document.querySelector("#root") as HTMLDivElement;
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
});

afterEach(async () => {
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  await act(async () => root.unmount());
  queryClient.clear();
  dom.window.close();
});

describe("SettingsUpdatesPanel", () => {
  test("does not claim the installation is current before a verified check", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async () => Response.json({
        currentVersion: "1.0.0",
        phase: "idle",
        managed: true,
        restartSupported: true,
        updateAvailable: false,
        restartRequired: false,
      } satisfies UpdateStatus)),
    });

    await renderPanel();
    await waitForText("No verified update check has completed yet.");
    expect(container.textContent).not.toContain("This installation is current.");
  });

  test("checks status, installs a verified release, then requests idle restart", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = {
          path: String(input),
          method: init?.method ?? "GET",
        };
        requests.push(request);
        if (request.path === "/api/update" && request.method === "GET") {
          return Response.json(available);
        }
        if (
          request.path === "/api/update/install"
          && request.method === "POST"
        ) {
          return Response.json(restartPending);
        }
        if (
          request.path === "/api/update/restart"
          && request.method === "POST"
        ) {
          return Response.json(restartPending, { status: 202 });
        }
        throw new Error(`Unexpected request: ${request.method} ${request.path}`);
      }),
    });

    await renderPanel();
    await waitForText("ArchCode v1.1.0 is ready to install.");
    expect(container.textContent).toContain("Managed by the official installer");

    await clickButton("Install update");
    await waitForText("The verified update is installed.");
    expect(button("Restart now")).not.toBeNull();
    expect(button("Install update").disabled).toBe(true);

    await clickButton("Restart now");
    expect(requests).toEqual([
      { path: "/api/update", method: "GET" },
      { path: "/api/update/install", method: "POST" },
      { path: "/api/update/restart", method: "POST" },
    ]);
  });

  test("renders streamed download progress from the process-level projection", async () => {
    queryClient.setQueryData(["update"], {
      ...available,
      phase: "downloading",
      progress: {
        phase: "downloading",
        downloadedBytes: 25,
        totalBytes: 100,
      },
    } satisfies UpdateStatus);
    queryClient.setQueryDefaults(["update"], {
      queryFn: async () => {
        throw new Error("cached projection should render first");
      },
      staleTime: Infinity,
    });

    await renderPanel();

    expect(container.textContent).toContain("Downloading");
    expect(container.textContent).toContain("25%");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

async function renderPanel(): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsUpdatesPanel />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing ${label} button`);
  return match;
}

async function waitForText(text: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Missing text: ${text}`);
}
