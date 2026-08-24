import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectTodo, SessionSummary } from "../api/types";
import { WorkbenchLayoutProvider } from "../context/workbench-layout";
import { hitlStore } from "../store/hitl-store";
import { sessionRuntimeStore } from "../store/session-runtime-store";

const bootstrapDom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/projects/demo/todos",
});
installDomGlobals(bootstrapDom);
const {
  ProjectTodosRoute,
} = await import("./project-todos");
const {
  planWorkCommand,
  ProjectTodoDetailRoute,
} = await import("./project-todo-detail");
bootstrapDom.window.close();

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let responseMode: "success" | "failure" | "pending";
let resolveIdeaPatch: (() => void) | undefined;
let patches: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof mock>;
let sessionSummaries: SessionSummary[];
let requests: Array<{ method: string; path: string; body?: unknown }>;
let sessionDetailResponse: () => Response | Promise<Response>;
let messageResponse: () => Response | Promise<Response>;
let createSessionResponse: () => Response | Promise<Response>;
let planResponse: () => Response | Promise<Response>;
let sessionInventoryResponse: () => Response | Promise<Response>;
let automationInventoryResponse: () => Response | Promise<Response>;

let todos: ProjectTodo[];

function todo(id: string, content: string, status: ProjectTodo["status"]): ProjectTodo {
  return { id, content, attachmentIds: [], status, revision: 3, createdAt: 1, updatedAt: 1 };
}

function installDomGlobals(target: JSDOM): void {
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
    CustomEvent: target.window.CustomEvent,
    MouseEvent: target.window.MouseEvent,
    TouchEvent: target.window.TouchEvent,
    KeyboardEvent: target.window.KeyboardEvent,
    MutationObserver: target.window.MutationObserver,
    getComputedStyle: target.window.getComputedStyle.bind(target.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(target.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(target.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(target.window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: query === "(max-width: 720px)" && target.window.innerWidth <= 720, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }),
  });
}

beforeEach(() => {
  hitlStore.getState().reset();
  sessionRuntimeStore.getState().reset();
  sessionRuntimeStore.getState().applySnapshot({ type: "session.runtime.snapshot", projectSlugs: ["demo"], families: [], createdAt: 1 });
  hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["demo"], entries: [], createdAt: 1 });
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos" });
  installDomGlobals(dom);
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  responseMode = "success";
  resolveIdeaPatch = undefined;
  todos = [
    todo("idea", "Idea", "idea"),
    todo("idea-next", "Next idea", "idea"),
    todo("ready", "Ready", "ready"),
  ];
  patches = [];
  requests = [];
  sessionSummaries = [];
  sessionDetailResponse = () => Response.json({
    nextModelSelection: {
      requested: { mode: "profile_default", selection: { model: "test:model" } },
      resolved: {
        selection: { model: "test:model" },
        providerId: "test",
        modelId: "model",
        providerDisplayName: "Test",
        modelDisplayName: "Model",
        resolution: "profile_default",
        modelRuntimeRevision: "runtime-1",
      },
    },
  });
  messageResponse = () => Response.json({ clientRequestId: "plan-command", status: "command" });
  createSessionResponse = () => Response.json({ todo: todos[2], sessionId: "discussion-new" });
  planResponse = () => Response.json({ plan: null });
  sessionInventoryResponse = () => Response.json({ sessions: sessionSummaries.map((session) => ({ session, latestExecution: null })) });
  automationInventoryResponse = () => Response.json({ automations: [] });
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "PATCH" && path.endsWith("/todos/idea")) {
      patches.push(body as Record<string, unknown>);
      if (responseMode === "failure") {
        todos[0] = { ...todos[0]!, revision: todos[0]!.revision + 1 };
        return Response.json({ error: { code: "CONFLICT", message: "stale Todo" } }, { status: 409 });
      }
      const respond = () => {
        const requestedStatus = (body as { status?: ProjectTodo["status"] } | undefined)?.status;
        todos[0] = { ...todos[0]!, status: requestedStatus ?? "ready", revision: todos[0]!.revision + 1 };
        return Response.json({ todo: todos[0] });
      };
      if (responseMode === "pending") return new Promise<Response>((resolve) => {
        resolveIdeaPatch = () => resolve(respond());
      });
      return respond();
    }
    if (method === "PATCH" && path.endsWith("/todos/ready")) {
      patches.push(body as Record<string, unknown>);
      const requestedStatus = (body as { status?: ProjectTodo["status"] } | undefined)?.status;
      todos[2] = { ...todos[2]!, status: requestedStatus ?? "in_progress", revision: 4 };
      return Response.json({ todo: todos[2] });
    }
    if (method === "PATCH" && path.endsWith("/todos/done")) {
      patches.push(body as Record<string, unknown>);
      const index = todos.findIndex((item) => item.id === "done");
      const requestedStatus = (body as { status?: ProjectTodo["status"] } | undefined)?.status;
      todos[index] = { ...todos[index]!, status: requestedStatus ?? "idea", revision: 4 };
      return Response.json({ todo: todos[index] });
    }
    if (method === "POST" && path.endsWith("/messages")) return messageResponse();
    if (method === "POST" && path.endsWith("/sessions")) return createSessionResponse();
    if (method === "GET" && path.endsWith("/attachments")) return Response.json({ todoRevision: 3, attachments: [] });
    if (method === "GET" && path.endsWith("/plan")) return planResponse();
    if (path.endsWith("/todos")) return Response.json({ todos });
    if (path.endsWith("/sessions")) return sessionInventoryResponse();
    if (path.includes("/sessions/")) return sessionDetailResponse();
    if (path.endsWith("/automations")) return automationInventoryResponse();
    return new Response("not found", { status: 404 });
  });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  hitlStore.getState().reset();
  sessionRuntimeStore.getState().reset();
  dom.window.close();
});

async function render(initialEntry = "/projects/demo/todos"): Promise<void> {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><WorkbenchLayoutProvider><MemoryRouter initialEntries={[initialEntry]}><Routes><Route path="/projects/:slug/todos" element={<ProjectTodosRoute />} /><Route path="/projects/:slug/todos/:todoId" element={<ProjectTodoDetailRoute />} /><Route path="/projects/:slug/sessions/:sessionId" element={<div data-testid="session-page" />} /></Routes></MemoryRouter></WorkbenchLayoutProvider></QueryClientProvider>);
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for the Todo interaction state");
}

async function renderSelectedTodo(): Promise<void> {
  await render("/projects/demo/todos/ready");
  await waitFor(() => document.querySelector('[aria-labelledby="todo-content-heading"]') !== null);
  await waitFor(() => document.body.textContent?.includes("Loading Plan…") === false);
}

function addDiscussionSummary(sessionId = "discussion-latest", todoId = "ready"): void {
  sessionSummaries.push({
    sessionId,
    rootSessionId: sessionId,
    cwd: "/tmp",
    agentName: "discussion",
    profile: "principal",
    activeSkillNames: ["shape-todo"],
    modelSelection: { revision: 0 },
    title: "Plan discussion",
    source: { kind: "todo", todoId, entry: "discussion" },
    createdAt: 2,
    updatedAt: 3,
  });
}

function addWorkSummary(sessionId = "work-latest", todoId = "ready"): void {
  sessionSummaries.push({
    sessionId,
    rootSessionId: sessionId,
    cwd: "/tmp",
    agentName: "lead",
    profile: "principal",
    activeSkillNames: ["orchestrate-work"],
    modelSelection: { revision: 0 },
    title: "Existing work",
    source: { kind: "todo", todoId, entry: "work" },
    createdAt: 2,
    updatedAt: 4,
  });
}

function findPlanButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Generate Plan") || candidate.textContent?.includes("Improve"),
  );
  if (!(button instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Plan action button was not rendered");
  }
  return button;
}

function previewButtonLabels(): string[] {
  const preview = document.querySelector('[data-testid="todo-preview"]');
  if (!(preview instanceof dom.window.HTMLElement)) throw new Error("Todo preview was not rendered");
  return [...preview.querySelectorAll("footer button")].map((button) => button.textContent?.trim() ?? "");
}

async function openPreview(todoId: string): Promise<void> {
  await click(document.querySelector(`[data-testid="todo-open-${todoId}"]`) as HTMLButtonElement);
  await waitFor(() => document.querySelector('[data-testid="todo-preview"]') !== null);
}

async function closePreview(): Promise<void> {
  await click(document.querySelector('[aria-label="Close preview"]') as HTMLButtonElement);
  await waitFor(() => document.querySelector('[data-testid="todo-preview"]') === null);
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function key(target: HTMLElement, value: string, options: { shiftKey?: boolean } = {}): Promise<void> {
  await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, code: value === " " ? "Space" : value, bubbles: true, ...options })));
  await settle();
}

function setViewport(width: number): void {
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: width });
}

describe("Project Todos Plan interactions", () => {
  test("distinguishes an existing empty Plan file from no Plan", async () => {
    planResponse = () => Response.json({
      plan: { path: ".archcode/plans/ready.md", markdown: "", updatedAt: 1 },
    });

    await renderSelectedTodo();
    await waitFor(() => document.querySelector('[aria-labelledby="todo-plan-heading"]')?.textContent?.includes(
      "Plan file exists but is empty",
    ) === true);

    expect(document.querySelector('[aria-labelledby="todo-plan-heading"]')?.textContent).toContain(
      "Plan file exists but is empty",
    );
  });

  test("creates one atomic Plan Discussion when none exists", async () => {
    await renderSelectedTodo();
    const planButton = findPlanButton();
    expect(planButton.disabled).toBe(false);

    await click(planButton);

    const creates = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({
      expectedRevision: 3,
      entry: "discussion",
      initialIntent: "plan",
    });
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(0);
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("keeps Plan available for a busy Discussion and creates one atomic replacement", async () => {
    addDiscussionSummary();
    sessionDetailResponse = () => Response.json({
      currentExecutionId: "execution-active",
      nextModelSelection: {
        requested: { mode: "profile_default", selection: { model: "test:model" } },
      },
    });
    await renderSelectedTodo();

    const planButton = findPlanButton();
    expect(planButton.disabled).toBe(false);
    await click(planButton);

    const creates = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ entry: "discussion", initialIntent: "plan" });
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(0);
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("reuses an idle Discussion with exactly one Plan command", async () => {
    addDiscussionSummary();
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    )).toHaveLength(0);
    const messages = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatchObject({
      text: planWorkCommand("ready"),
      attachmentIds: [],
      requestedModelSelection: {
        mode: "profile_default",
        selection: { model: "test:model" },
      },
    });
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("falls back to a new Plan Discussion when idle reuse loses the acceptance race", async () => {
    addDiscussionSummary();
    messageResponse = () => Response.json({
      error: {
        code: "BAD_REQUEST",
        message: "The Session is waiting for a tool response.",
        details: {
          scopeCode: "SESSION_TOOL_BATCH_ACTIVE",
          sessionId: "discussion-latest",
        },
      },
    }, { status: 409 });
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(1);
    const creates = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ entry: "discussion", initialIntent: "plan" });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("falls back to a new Plan Discussion when the linked Session is stale", async () => {
    addDiscussionSummary();
    sessionDetailResponse = () => Response.json({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
    }, { status: 404 });
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    )).toHaveLength(1);
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(0);
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("does not replace an unavailable project with a new Plan Discussion", async () => {
    addDiscussionSummary();
    sessionDetailResponse = () => Response.json({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
    }, { status: 404 });
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    )).toHaveLength(0);
    expect(document.querySelector('[data-testid="session-page"]')).toBeNull();
    const error = document.querySelector('[role="alert"]');
    expect(error?.textContent).toBe("Project not found");
  });

  test("shows local progress, blocks a duplicate click, and recovers beside the Plan action", async () => {
    addDiscussionSummary();
    let resolveMessage: ((response: Response) => void) | undefined;
    messageResponse = () => new Promise<Response>((resolve) => {
      resolveMessage = resolve;
    });
    await renderSelectedTodo();

    const planButton = findPlanButton();
    await act(async () => {
      planButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      planButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => planButton.textContent?.includes("Opening…") === true);

    expect(planButton.disabled).toBe(true);
    expect(planButton.querySelector(".animate-activity")).not.toBeNull();
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(1);

    await act(async () => {
      resolveMessage?.(Response.json({
        error: { code: "INTERNAL_ERROR", message: "Plan service unavailable" },
      }, { status: 500 }));
    });
    await waitFor(() => planButton.disabled === false);

    expect(planButton.textContent).toContain("Generate Plan");
    const error = document.querySelector('[role="alert"]');
    expect(error?.textContent).toBe("Plan service unavailable");
  });
});

describe("Project Todos preview actions", () => {
  test("keeps Session capabilities visible but disabled while inventory is loading", async () => {
    sessionInventoryResponse = () => new Promise<Response>(() => {});
    await render();
    await openPreview("ready");

    expect(document.querySelector('[data-testid="todo-preview-operational-state"]')?.textContent).toContain("Loading operational state");
    const stage = document.querySelector('[aria-label="Change Todo stage, current Ready"]') as HTMLButtonElement;
    const openDetails = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Open details")!;
    const loadingWork = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Loading work…")!;
    const loadingDiscussion = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Loading discussion…")!;
    expect(stage.disabled).toBe(false);
    expect(loadingWork.disabled).toBe(true);
    expect(loadingDiscussion.disabled).toBe(true);
    expect(openDetails.disabled).toBe(false);
    expect(previewButtonLabels()).toEqual(["Loading work…", "Open details", "Loading discussion…"]);
    await click(loadingWork);
    expect(requests.filter(({ method }) => method === "POST" || method === "PATCH")).toHaveLength(0);
    await click(stage);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))?.disabled).toBe(true);
    await closePreview();
    await openPreview("idea");
    expect(previewButtonLabels()).toEqual(["Loading discussion…", "Open details"]);
  });

  test("keeps Session capabilities active and non-Done Stage mutable while runtime and HITL load", async () => {
    addDiscussionSummary("ready-discussion", "ready");
    addWorkSummary("ready-work", "ready");
    sessionRuntimeStore.getState().invalidateSnapshots();
    hitlStore.getState().invalidateSnapshots();
    await render();
    await openPreview("ready");

    expect(document.querySelector('[data-testid="todo-preview-operational-state"]')?.textContent).toContain("Loading operational state");
    const stage = document.querySelector('[aria-label="Change Todo stage, current Ready"]') as HTMLButtonElement;
    expect(stage.disabled).toBe(false);
    expect(previewButtonLabels()).toEqual(["Continue Work", "Open details", "Continue Discussion"]);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Continue Work")?.disabled).toBe(false);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Continue Discussion")?.disabled).toBe(false);
    await click(stage);
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(options.find((button) => button.textContent?.includes("Done"))?.disabled).toBe(true);
    await click(options.find((button) => button.textContent?.includes("In progress"))!);
    await waitFor(() => patches.length === 1);
    expect(patches).toEqual([{ expectedRevision: 3, status: "in_progress" }]);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  test("keeps Session capabilities active while Automation failure blocks only Done", async () => {
    automationInventoryResponse = () => Response.json({ error: { code: "INTERNAL_ERROR", message: "Automation inventory failed" } }, { status: 500 });
    await render();
    await openPreview("ready");

    expect(document.querySelector('[data-testid="todo-preview"]')?.textContent).toContain("Ready");
    expect(document.querySelector('[data-testid="todo-preview-operational-state"]')?.textContent).toContain("Operational state unavailable");
    const stage = document.querySelector('[aria-label="Change Todo stage, current Ready"]') as HTMLButtonElement;
    const openDetails = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Open details")!;
    expect(stage.disabled).toBe(false);
    expect(openDetails.disabled).toBe(false);
    expect(previewButtonLabels()).toEqual(["Start Work", "Open details", "Discussion"]);
    await click(stage);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))?.disabled).toBe(true);
    expect(requests.filter(({ method }) => method === "POST" || method === "PATCH")).toHaveLength(0);
  });

  test("keeps failed Session capabilities disabled while ordinary Stage remains mutable", async () => {
    sessionInventoryResponse = () => Response.json({ error: { code: "INTERNAL_ERROR", message: "Session inventory failed" } }, { status: 500 });
    await render();
    await openPreview("ready");

    const stage = document.querySelector('[aria-label="Change Todo stage, current Ready"]') as HTMLButtonElement;
    const unavailableWork = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Work unavailable")!;
    const unavailableDiscussion = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Discussion unavailable")!;
    expect(previewButtonLabels()).toEqual(["Work unavailable", "Open details", "Discussion unavailable"]);
    expect(unavailableWork.disabled).toBe(true);
    expect(unavailableDiscussion.disabled).toBe(true);
    await click(unavailableWork);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(0);

    await click(stage);
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(options.find((button) => button.textContent?.includes("Done"))?.disabled).toBe(true);
    await click(options.find((button) => button.textContent?.includes("In progress"))!);
    await waitFor(() => patches.length === 1);
    expect(patches).toEqual([{ expectedRevision: 3, status: "in_progress" }]);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  test("allows moving out of Done while operational state is unavailable", async () => {
    todos.push(todo("done", "Done item", "done"));
    automationInventoryResponse = () => Response.json({ error: { code: "INTERNAL_ERROR", message: "Automation inventory failed" } }, { status: 500 });
    await render();
    await openPreview("done");

    const stage = document.querySelector('[aria-label="Change Todo stage, current Done"]') as HTMLButtonElement;
    expect(stage.disabled).toBe(false);
    await click(stage);
    const idea = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Idea"))!;
    expect(idea.disabled).toBe(false);
    await click(idea);
    await waitFor(() => patches.length === 1);
    expect(patches).toEqual([{ expectedRevision: 3, status: "idea" }]);
  });

  test("dismisses the Stage menu on Tab and continues through the trapped Preview order", async () => {
    await render();
    await openPreview("idea");
    const trigger = document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement;
    trigger.focus();
    await key(trigger, "ArrowDown");
    await key(document.activeElement as HTMLElement, "Tab");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Start discussion");

    trigger.focus();
    await key(trigger, "ArrowDown");
    await key(document.activeElement as HTMLElement, "Tab", { shiftKey: true });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close preview");
  });

  test("moves Stage through the custom keyboard menu and restores focus to the moved List row", async () => {
    await render();
    await openPreview("idea");
    const trigger = document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement;
    trigger.focus();

    await key(trigger, "ArrowDown");
    const ideaOption = document.querySelector('[role="menuitemradio"][aria-checked="true"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(ideaOption);
    await key(ideaOption, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Ready");
    await key(document.activeElement as HTMLElement, "Enter");

    await waitFor(() => patches.length === 1);
    await waitFor(() => document.querySelector('[aria-label="Change Todo stage, current Ready"]') !== null);
    expect(patches).toEqual([{ expectedRevision: 3, status: "ready" }]);
    expect(document.querySelector('[aria-labelledby="todo-list-ready"] [data-testid="todo-open-idea"]')).not.toBeNull();

    await closePreview();
    await waitFor(() => document.activeElement === document.querySelector('[data-testid="todo-open-idea"]'));
  });

  test("keeps Preview open on a revision conflict and focuses explicit refresh-and-retry recovery", async () => {
    responseMode = "failure";
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Ready"))!);

    await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes("changed elsewhere") === true);
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Refresh and retry")!;
    expect(document.querySelector('[data-testid="todo-preview"]')).not.toBeNull();
    expect(document.activeElement).toBe(retry);
    expect(patches).toEqual([{ expectedRevision: 3, status: "ready" }]);

    responseMode = "success";
    await click(retry);
    await waitFor(() => document.querySelector('[aria-label="Change Todo stage, current Ready"]') !== null);
    expect(patches).toEqual([
      { expectedRevision: 3, status: "ready" },
      { expectedRevision: 4, status: "ready" },
    ]);
  });

  test("keeps Preview busy and blocks every dismissal while a Stage mutation is pending", async () => {
    responseMode = "pending";
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Ready"))!);

    await waitFor(() => document.querySelector('[data-testid="todo-preview"]')?.getAttribute("aria-busy") === "true");
    const preview = document.querySelector('[data-testid="todo-preview"]') as HTMLElement;
    expect((document.querySelector('[aria-label="Close preview"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[aria-label="Close Todo preview"]') as HTMLButtonElement).disabled).toBe(true);
    await key(document.activeElement as HTMLElement, "Escape");
    expect(document.querySelector('[data-testid="todo-preview"]')).toBe(preview);

    await act(async () => resolveIdeaPatch?.());
    await waitFor(() => document.querySelector('[aria-label="Change Todo stage, current Ready"]') !== null);
    expect(document.querySelector('[data-testid="todo-preview"]')).not.toBeNull();
  });

  test("confirms Done only while authoritative linked work is Running", async () => {
    addWorkSummary("idea-work", "idea");
    sessionInventoryResponse = () => Response.json({ sessions: sessionSummaries.map((session) => ({
      session,
      latestExecution: session.sessionId === "idea-work"
        ? { id: "execution-1", status: "running", startedAt: 3 }
        : null,
    })) });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "idea-work", activity: "running" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["demo"], entries: [], createdAt: 1 });
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!);

    expect(document.querySelector('[aria-label="Confirm Todo stage change"]')?.textContent).toContain("Linked work is still running");
    expect(patches).toEqual([]);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Move to Done")!);
    await waitFor(() => patches.length === 1);
    expect(patches).toEqual([{ expectedRevision: 3, status: "done" }]);
  });

  test("does not submit Done after operational readiness expires from an open confirmation", async () => {
    addWorkSummary("idea-work", "idea");
    sessionInventoryResponse = () => Response.json({ sessions: sessionSummaries.map((session) => ({
      session,
      latestExecution: session.sessionId === "idea-work"
        ? { id: "execution-1", status: "running", startedAt: 3 }
        : null,
    })) });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "idea-work", activity: "running" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["demo"], entries: [], createdAt: 1 });
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!);

    expect(document.querySelector('[aria-label="Confirm Todo stage change"]')?.textContent).toContain("Linked work is still running");
    expect(patches).toEqual([]);

    await act(async () => sessionRuntimeStore.getState().invalidateSnapshots());
    await waitFor(() => document.querySelector('[aria-label="Confirm Todo stage change"]') === null);
    expect(document.querySelector('[data-testid="todo-preview-operational-state"]')?.textContent).toContain("Loading operational state");
    expect(document.querySelector('[data-testid="todo-preview"]')?.textContent).not.toContain("waiting for you");
    expect(patches).toEqual([]);

    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!;
    expect(done.disabled).toBe(true);
    await click(done);
    expect(patches).toEqual([]);
  });

  test("confirms Done while authoritative linked work Needs you", async () => {
    addWorkSummary("idea-work", "idea");
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "idea-work", activity: "idle" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["demo"],
      entries: [{
        projectSlug: "demo",
        hitlId: "question-1",
        ownerSessionId: "idea-work",
        rootSessionId: "idea-work",
        ownerAgentName: "lead",
        ownerSessionTitle: "Existing work",
        view: {
          hitlId: "question-1",
          owner: { type: "session", id: "idea-work" },
          source: { type: "ask_user", toolCallId: "ask-1" },
          status: "pending",
          displayPayload: { title: "Need input", redacted: true },
          allowedActions: ["answer", "cancel"],
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
      }],
      createdAt: 1,
    });
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!);

    expect(document.querySelector('[aria-label="Confirm Todo stage change"]')?.textContent).toContain("Linked work is still waiting for you");
    expect(patches).toEqual([]);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Move to Done")!);
    await waitFor(() => patches.length === 1);
    expect(patches).toEqual([{ expectedRevision: 3, status: "done" }]);
  });

  test("removes Done retry without resubmitting when operational readiness expires after failure", async () => {
    responseMode = "failure";
    addWorkSummary("idea-work", "idea");
    sessionInventoryResponse = () => Response.json({ sessions: sessionSummaries.map((session) => ({
      session,
      latestExecution: session.sessionId === "idea-work"
        ? { id: "execution-1", status: "running", startedAt: 3 }
        : null,
    })) });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "idea-work", activity: "running" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["demo"], entries: [], createdAt: 1 });
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Move to Done")!);

    await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes("changed elsewhere") === true);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some((button) => button.textContent === "Refresh and retry")).toBe(true);
    expect(patches).toEqual([{ expectedRevision: 3, status: "done" }]);

    await act(async () => hitlStore.getState().invalidateSnapshots());
    await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).every((button) => button.textContent !== "Refresh and retry"));
    expect(document.querySelector('[data-testid="todo-preview-operational-state"]')?.textContent).toContain("Loading operational state");
    expect(patches).toEqual([{ expectedRevision: 3, status: "done" }]);

    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!;
    expect(done.disabled).toBe(true);
    await click(done);
    expect(patches).toEqual([{ expectedRevision: 3, status: "done" }]);
  });

  test("moves directly to Done when linked work is quiet", async () => {
    addWorkSummary("idea-work", "idea");
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "idea-work", activity: "idle" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["demo"], entries: [], createdAt: 1 });
    await render();
    await openPreview("idea");
    await click(document.querySelector('[aria-label="Change Todo stage, current Idea"]') as HTMLButtonElement);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes("Done"))!);

    await waitFor(() => patches.length === 1);
    expect(document.querySelector('[aria-label="Confirm Todo stage change"]')).toBeNull();
    expect(patches).toEqual([{ expectedRevision: 3, status: "done" }]);
  });

  test("presents Scheduled as a neutral static state in List and Preview", async () => {
    automationInventoryResponse = () => Response.json({ automations: [{
      automation: {
        id: "automation-1",
        projectSlug: "demo",
        origin: { kind: "todo", todoId: "idea", sessionId: "automation-setup" },
        name: "Nightly check",
        trigger: { kind: "once", at: "2026-08-25T00:00:00.000Z" },
        action: { kind: "start_session", message: "Check", location: "project" },
        status: "active",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        nextFireAt: "2026-08-25T00:00:00.000Z",
      },
      latestInvocation: null,
    }] });
    sessionRuntimeStore.getState().applySnapshot({ type: "session.runtime.snapshot", projectSlugs: ["demo"], families: [], createdAt: 1 });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["demo"], entries: [], createdAt: 1 });
    await render();

    const row = document.querySelector('[data-testid="todo-open-idea"]') as HTMLButtonElement;
    expect(document.querySelector('[data-testid="todo-operational-idea"]')?.className).toContain("text-neutral");
    expect(row.firstElementChild?.className).toContain("border-border-subtle bg-bg-muted text-text-tertiary");
    await openPreview("idea");
    const field = document.querySelector('[data-testid="todo-preview-operational"]') as HTMLElement;
    expect(field.textContent).toContain("Scheduled");
    expect(field.className).toContain("border-border-default bg-bg-muted");
    expect(field.firstElementChild?.className).toContain("bg-text-muted");
  });

  test("shows the exact unlinked action matrix for every active lifecycle status", async () => {
    todos.push(todo("progress", "In Progress", "in_progress"), todo("done", "Done", "done"));
    await render();

    const cases = [
      ["idea", ["Start discussion", "Open details"]],
      ["ready", ["Start Work", "Open details", "Discussion"]],
      ["progress", ["Start Work", "Open details", "Discussion"]],
      ["done", ["Open details"]],
    ] as const;

    for (const [todoId, expected] of cases) {
      await openPreview(todoId);
      expect(previewButtonLabels()).toEqual([...expected]);
      await closePreview();
    }
  });

  test("replaces creation actions with exact continuation actions when linked work exists", async () => {
    todos.push(todo("progress", "In Progress", "in_progress"), todo("done", "Done", "done"));
    addDiscussionSummary("idea-discussion", "idea");
    addDiscussionSummary("ready-discussion", "ready");
    addWorkSummary("ready-work", "ready");
    addDiscussionSummary("progress-discussion", "progress");
    addWorkSummary("progress-work", "progress");
    await render();

    const cases = [
      ["idea", ["Continue Discussion", "Open details"]],
      ["ready", ["Continue Work", "Open details", "Continue Discussion"]],
      ["progress", ["Continue Work", "Open details", "Continue Discussion"]],
      ["done", ["Open details"]],
    ] as const;

    for (const [todoId, expected] of cases) {
      await openPreview(todoId);
      expect(previewButtonLabels()).toEqual([...expected]);
      await closePreview();
    }
  });
});

describe("Project Todos transient and keyboard contracts", () => {
  test("contains preview focus, cycles Tab in both directions, and restores the exact origin", async () => {
    await render();
    const origin = document.querySelector('[data-testid="todo-open-idea"]') as HTMLButtonElement;
    await click(origin);
    await waitFor(() => document.activeElement?.id === "todo-preview-heading");

    await key(document.activeElement as HTMLElement, "Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close preview");

    await key(document.activeElement as HTMLElement, "Tab", { shiftKey: true });
    expect(document.activeElement?.textContent).toBe("Open details");
    await key(document.activeElement as HTMLElement, "Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close preview");

    await key(document.activeElement as HTMLElement, "Escape");
    await waitFor(() => document.querySelector('[data-testid="todo-preview"]') === null);
    await waitFor(() => document.activeElement === origin);
  });

  for (const width of [720, 721] as const) {
    test(`${width}px ${width === 720 ? "opens canonical detail directly" : "opens desktop preview"}`, async () => {
      setViewport(width);
      await render();
      await click(document.querySelector('[data-testid="todo-open-idea"]') as HTMLButtonElement);
      if (width === 720) {
        await waitFor(() => document.querySelector('[aria-labelledby="todo-content-heading"]') !== null);
        expect(document.querySelector('[data-testid="todo-preview"]')).toBeNull();
      } else {
        await waitFor(() => document.querySelector('[data-testid="todo-preview"]') !== null);
        expect(document.querySelector('[aria-labelledby="todo-content-heading"]')).toBeNull();
      }
    });
  }

  for (const [surface, width] of [["rejected", 1024], ["rejected", 390], ["archived", 1024], ["archived", 390]] as const) {
    test(`${surface} at ${width}px always opens canonical detail and never preview`, async () => {
      setViewport(width);
      const item = surface === "rejected"
        ? { ...todo("rejected", "Rejected item", "rejected"), rejectionReason: "Not now" }
        : { ...todo("archived", "Archived item", "done"), archivedAt: 2 };
      todos.push(item);
      await render(`/projects/demo/todos?surface=${surface}`);
      await click(document.querySelector(`[data-testid="todo-${surface}"]`) as HTMLButtonElement);
      await waitFor(() => document.querySelector('[aria-labelledby="todo-content-heading"]') !== null);
      expect(document.querySelector('[data-testid="todo-preview"]')).toBeNull();
      expect(document.querySelector('[aria-labelledby="todo-content-heading"]')?.textContent).toContain(surface === "rejected" ? "Rejected item" : "Archived item");
      expect(Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === (surface === "rejected" ? "Restore to Idea" : "Restore"))).toBe(true);
    });
  }
});
