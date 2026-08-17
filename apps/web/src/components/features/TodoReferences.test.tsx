import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router-dom";
import type { ProjectTodo } from "../../api/types";
import { canOpenTodoAttachmentInline, TodoReferences } from "./TodoReferences";

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let requests: Array<{ method: string; url: string; body?: string }>;
let serverAttachmentIds: string[];

const todo: ProjectTodo = {
  id: "todo-1",
  content: "Attach supporting materials",
  status: "ready",
  attachmentIds: [],
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

function installDom(target: JSDOM): void {
  Object.assign(globalThis, {
    window: target.window,
    document: target.window.document,
    navigator: target.window.navigator,
    HTMLElement: target.window.HTMLElement,
    HTMLInputElement: target.window.HTMLInputElement,
    Element: target.window.Element,
    Node: target.window.Node,
    Event: target.window.Event,
    MouseEvent: target.window.MouseEvent,
    KeyboardEvent: target.window.KeyboardEvent,
    MutationObserver: target.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos/todo-1" });
  installDom(dom);
  requests = [];
  serverAttachmentIds = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (method === "GET") return Response.json({ todoRevision: 1, attachments: [] });
      const parsed = new URL(url, "http://localhost");
      if (method === "PUT") {
        const expectedRevision = Number(parsed.searchParams.get("expectedRevision"));
        const name = parsed.searchParams.get("name") ?? "file";
        const attachmentId = parsed.pathname.split("/").pop()!;
        if (!serverAttachmentIds.includes(attachmentId)) serverAttachmentIds.push(attachmentId);
        return Response.json({
          todo: { ...todo, attachmentIds: [...serverAttachmentIds], revision: expectedRevision + 1 },
          attachment: { id: attachmentId, name, mediaType: name.endsWith(".pdf") ? "application/pdf" : "text/plain", sizeBytes: 5, kind: name.endsWith(".pdf") ? "file" : "file" },
        });
      }
      return Response.json({ todo: { ...todo, revision: 2 } });
    }),
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  dom.window.close();
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Todo References", () => {
  test("allows safe images and PDFs to open, but never SVG", () => {
    expect(canOpenTodoAttachmentInline({ id: "image", name: "a.png", mediaType: "image/png", sizeBytes: 1, kind: "image" })).toBe(true);
    expect(canOpenTodoAttachmentInline({ id: "pdf", name: "a.pdf", mediaType: "application/pdf", sizeBytes: 1, kind: "file" })).toBe(true);
    expect(canOpenTodoAttachmentInline({ id: "svg", name: "a.svg", mediaType: "image/svg+xml", sizeBytes: 1, kind: "image" })).toBe(false);
    expect(canOpenTodoAttachmentInline({ id: "forged", name: "a.png", mediaType: "image/png", sizeBytes: 1, kind: "file" })).toBe(false);
    expect(canOpenTodoAttachmentInline({ id: "html", name: "a.html", mediaType: "text/html", sizeBytes: 1, kind: "file" })).toBe(false);
  });

  test("keeps the prototype's visible Remove action with a 44px coarse target", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async () => Response.json({
        todoRevision: 1,
        attachments: [{ id: "brief", name: "brief.pdf", mediaType: "application/pdf", sizeBytes: 5, kind: "file" }],
      })),
    });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TodoReferences slug="demo" todo={{ ...todo, attachmentIds: ["brief"] }} />
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();

    const remove = document.querySelector('[aria-label="Remove brief.pdf"]');
    expect(remove?.textContent).toBe("Remove");
    expect(remove?.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(document.getElementById("todo-references-help")?.textContent).toContain("PRDs, designs, logs, and images");
  });

  test("uploads selected files serially with the revision returned by the previous mutation", async () => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TodoReferences slug="demo" todo={todo} />
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const first = new File(["one!"], "one.txt", { type: "text/plain" });
    const second = new File(["two!"], "two.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [first, second] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    await settle();
    await settle();

    const uploads = requests.filter((request) => request.method === "PUT");
    expect(uploads).toHaveLength(2);
    expect(new URL(uploads[0]!.url, "http://localhost").searchParams.get("expectedRevision")).toBe("1");
    expect(new URL(uploads[1]!.url, "http://localhost").searchParams.get("expectedRevision")).toBe("2");
    expect(document.body.textContent).toContain("one.txt");
    expect(document.body.textContent).toContain("two.txt");
  });

  test("refetches the authoritative list when upload succeeds without a cached list", async () => {
    const existing = { id: "existing", name: "existing.txt", mediaType: "text/plain", sizeBytes: 3, kind: "file" as const };
    const todoWithExisting: ProjectTodo = { ...todo, attachmentIds: [existing.id], revision: 2 };
    let getCalls = 0;
    let uploadedId = "";
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (method === "GET") {
          getCalls += 1;
          if (getCalls === 1) return Response.json({ error: { message: "temporary" } }, { status: 500 });
          return Response.json({
            todoRevision: 3,
            attachments: [
              existing,
              { id: uploadedId, name: "new.txt", mediaType: "text/plain", sizeBytes: 3, kind: "file" },
            ],
          });
        }
        const parsed = new URL(url, "http://localhost");
        uploadedId = parsed.pathname.split("/").pop()!;
        return Response.json({
          todo: { ...todoWithExisting, attachmentIds: [existing.id, uploadedId], revision: 3 },
          attachment: { id: uploadedId, name: "new.txt", mediaType: "text/plain", sizeBytes: 3, kind: "file" },
        });
      }),
    });

    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TodoReferences slug="demo" todo={todoWithExisting} />
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["new"], "new.txt", { type: "text/plain" })] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    await settle();
    await settle();

    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain("existing.txt");
    expect(document.body.textContent).toContain("new.txt");
  });

  test("retries after a failed upload even when revision refresh is still pending", async () => {
    let getCalls = 0;
    let putCalls = 0;
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (method === "GET") {
          getCalls += 1;
          if (getCalls === 1) return Response.json({ todoRevision: 1, attachments: [] });
          return await refreshResponse;
        }
        putCalls += 1;
        if (putCalls === 1) {
          return Response.json({ error: { message: "Revision changed" } }, { status: 409 });
        }
        const parsed = new URL(url, "http://localhost");
        const attachmentId = parsed.pathname.split("/").pop()!;
        return Response.json({
          todo: { ...todo, attachmentIds: [attachmentId], revision: 6 },
          attachment: {
            id: attachmentId,
            name: "retry.txt",
            mediaType: "text/plain",
            sizeBytes: 5,
            kind: "file",
          },
        });
      }),
    });

    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TodoReferences slug="demo" todo={todo} />
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["retry"], "retry.txt", { type: "text/plain" })],
    });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    await settle();

    const retry = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Retry"));
    expect(retry).toBeDefined();
    await act(async () => retry!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await act(async () => resolveRefresh(Response.json({ todoRevision: 5, attachments: [] })));
    await settle();
    await settle();

    expect(putCalls).toBe(2);
    const uploads = requests.filter((request) => request.method === "PUT");
    expect(new URL(uploads[1]!.url, "http://localhost").searchParams.get("expectedRevision")).toBe("5");
    expect(document.body.textContent).toContain("retry.txt");
    expect(document.body.textContent).not.toContain("Upload failed");
  });
});
