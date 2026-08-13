import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectSessionInventoryItem, ProjectTodo } from "../api/types";

mock.module("../components/primitives/MarkdownContent", () => ({
  MarkdownContent: ({ children }: { children: ReactNode }) => <pre data-testid="markdown-source">{children}</pre>,
}));

const bootstrapDom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
installDom(bootstrapDom);
const { ProjectTodoDetailRoute } = await import("./project-todo-detail");
bootstrapDom.window.close();

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let currentTodo: ProjectTodo;
let inventoryItems: ProjectSessionInventoryItem[];
let sessionDetails: Map<string, unknown>;
let fetchPaths: string[];
let planResponse: { plan: null | { path: string; markdown: string } };

function todo(status: ProjectTodo["status"]): ProjectTodo {
  return { id: "todo-1", content: "Todo body", attachmentIds: [], status, revision: 1, createdAt: 1, updatedAt: 1 };
}

function inventory(sessionId: string, input: { endedAt: number; updatedAt: number; entry?: "work" | "discussion" }): ProjectSessionInventoryItem {
  return {
    session: {
      sessionId,
      rootSessionId: sessionId,
      cwd: "/workspace",
      agentName: input.entry === "discussion" ? "discussion" : "lead",
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: sessionId,
      source: { kind: "todo", todoId: "todo-1", entry: input.entry ?? "work" },
      createdAt: 1,
      updatedAt: input.updatedAt,
    },
    latestExecution: { id: `${sessionId}-execution`, status: "completed", startedAt: 1, endedAt: input.endedAt },
  };
}

function session(finalOutputStepId: string | undefined, parts: readonly string[]): unknown {
  return {
    executions: [{
      id: "execution",
      status: "completed",
      startedAt: 1,
      endedAt: 10,
      ...(finalOutputStepId === undefined ? {} : { finalOutputStepId }),
    }],
    messages: finalOutputStepId === undefined ? [] : [{
      id: "final-message",
      role: "assistant",
      executionId: "execution",
      runOrdinal: 0,
      stepId: finalOutputStepId,
      outputPhase: "final_answer",
      createdAt: 1,
      completedAt: 2,
      parts: parts.map((text, index) => ({
        type: "assistant-output",
        id: `part-${index}`,
        blockId: `block-${index}`,
        text,
        createdAt: 1,
        completedAt: 2,
      })),
    }],
  };
}

function installDom(target: JSDOM): void {
  Object.assign(globalThis, {
    window: target.window,
    document: target.window.document,
    navigator: target.window.navigator,
    HTMLElement: target.window.HTMLElement,
    HTMLButtonElement: target.window.HTMLButtonElement,
    HTMLInputElement: target.window.HTMLInputElement,
    HTMLTextAreaElement: target.window.HTMLTextAreaElement,
    Element: target.window.Element,
    Node: target.window.Node,
    NodeFilter: target.window.NodeFilter,
    DocumentFragment: target.window.DocumentFragment,
    Event: target.window.Event,
    MouseEvent: target.window.MouseEvent,
    MutationObserver: target.window.MutationObserver,
    getComputedStyle: target.window.getComputedStyle.bind(target.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(target.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(target.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos/todo-1" });
  installDom(dom);
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  currentTodo = todo("done");
  inventoryItems = [];
  sessionDetails = new Map();
  fetchPaths = [];
  planResponse = { plan: null };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://localhost").pathname;
    fetchPaths.push(path);
    if (path === "/api/projects/demo/todos") return Response.json({ todos: [currentTodo] });
    if (path === "/api/projects/demo/sessions") return Response.json({ sessions: inventoryItems });
    if (path === "/api/projects/demo/automations") return Response.json({ automations: [] });
    if (path.endsWith("/attachments")) return Response.json({ todoRevision: 1, attachments: [] });
    if (path.endsWith("/plan")) return Response.json(planResponse);
    const sessionId = path.match(/\/sessions\/([^/]+)$/)?.[1];
    if (sessionId && sessionDetails.has(sessionId)) return Response.json(sessionDetails.get(sessionId));
    return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
  }) });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  dom.window.close();
});

async function renderRoute(): Promise<void> {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/projects/demo/todos/todo-1"]}>
        <Routes><Route path="/projects/:slug/todos/:todoId" element={<ProjectTodoDetailRoute />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await waitFor(() => document.querySelector('[aria-labelledby="todo-brief-heading"]') !== null);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error("Timed out waiting for Todo Result route state");
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Project Todo Result route", () => {
  test("keeps archived content editable while hiding every Plan work launcher", async () => {
    currentTodo = { ...todo("ready"), archivedAt: 2 };
    planResponse = { plan: { path: ".archcode/plans/todo-1.md", markdown: "# Archived plan" } };

    await renderRoute();
    await waitFor(() => document.querySelector("#todo-plan-heading") !== null);

    const buttons = [...document.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(buttons).toContain("Edit");
    expect(buttons).toContain("Add files");
    expect(buttons).not.toContain("Generate Plan");
    expect(buttons).not.toContain("Improve");
  });

  test("renders Done raw parts separately in source order and fetches only the selected Session", async () => {
    const first = "  First raw block\n";
    const second = "\nSecond raw block  ";
    inventoryItems = [
      inventory("older-work", { endedAt: 8, updatedAt: 50 }),
      inventory("selected-work", { endedAt: 10, updatedAt: 20 }),
      inventory("newer-discussion", { endedAt: 99, updatedAt: 99, entry: "discussion" }),
    ];
    sessionDetails.set("selected-work", session("final-step", [first, second]));
    sessionDetails.set("older-work", session("older-step", ["older result"]));

    await renderRoute();
    await waitFor(() => document.querySelector('[data-testid="todo-result"]') !== null);

    expect(document.querySelector("#todo-result-heading")?.textContent).toBe("Accepted outcome");
    const sources = [...document.querySelectorAll('[data-testid="todo-result-part"] [data-testid="markdown-source"]')];
    expect(sources.map((source) => source.textContent)).toEqual([first, second]);
    expect(document.querySelector('[data-testid="todo-result"] a')?.getAttribute("href")).toBe("/projects/demo/sessions/selected-work");
    expect(fetchPaths.filter((path) => path.includes("/sessions/"))).toEqual(["/api/projects/demo/sessions/selected-work"]);
  });

  test("uses Result for review before Done", async () => {
    currentTodo = todo("in_progress");
    inventoryItems = [inventory("review-work", { endedAt: 10, updatedAt: 10 })];
    sessionDetails.set("review-work", session("final-step", ["Review this"]));

    await renderRoute();
    await waitFor(() => document.querySelector('[data-testid="todo-result"]') !== null);

    expect(document.querySelector("#todo-result-heading")?.textContent).toBe("Result for review");
    expect(fetchPaths.filter((path) => path.includes("/sessions/"))).toEqual(["/api/projects/demo/sessions/review-work"]);
  });

  test("hides Result for a completed tool-only Session without trusted final output", async () => {
    inventoryItems = [inventory("tool-only", { endedAt: 10, updatedAt: 10 })];
    sessionDetails.set("tool-only", {
      executions: [{ id: "execution", status: "completed", startedAt: 1, endedAt: 10, finalOutputStepId: "tool-step" }],
      messages: [{
        id: "tool-message",
        role: "tool",
        executionId: "execution",
        runOrdinal: 0,
        stepId: "tool-step",
        createdAt: 1,
        completedAt: 2,
        parts: [],
      }],
    });

    await renderRoute();
    await waitFor(() => fetchPaths.includes("/api/projects/demo/sessions/tool-only"));
    await settle();
    await settle();

    expect(document.querySelector('[data-testid="todo-result"]')).toBeNull();
    expect(fetchPaths.filter((path) => path.includes("/sessions/"))).toEqual(["/api/projects/demo/sessions/tool-only"]);
  });
});
