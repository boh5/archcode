import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompletedToolPart, RunningToolPart } from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ToolCard } from "./ToolCard";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  throw new Error("Unexpected fetch");
});

const artifactPart: CompletedToolPart = {
  type: "tool",
  id: "tool-edit",
  state: "completed",
  toolCallId: "call-edit",
  toolName: "file_edit",
  input: { path: "/target.ts", edits: [{ oldString: "old", newString: "new" }] },
  result: {
    isError: false,
    output: {
      preview: "Edit applied successfully",
      completeness: "partial",
      observed: { bytes: 300, lines: 30 },
      canonical: { bytes: 280, lines: 28 },
      stored: { bytes: 200, lines: 20 },
      omitted: { bytes: 80, lines: 8 },
      recovery: {
        kind: "artifact",
        outputRef: "abcdefghijklmnopqrstuv",
        expiresAt: Number.MAX_SAFE_INTEGER,
        canRead: true,
        canSearch: true,
      },
    },
    details: {
      presentations: [{
        kind: "diff",
        files: [{
          path: "src/changed.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          hunks: [{
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "delete", content: "const value = 'old';" },
              { type: "add", content: "const value = 'new';" },
            ],
          }],
        }],
      }],
    },
  },
  createdAt: 1,
  startedAt: 2,
  endedAt: 3,
};

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    InputEvent: dom.window.InputEvent,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    fetch: fetchMock,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("ToolCard output viewer", () => {
  test("auto-expands the first live Bash output, respects manual collapse, and switches in place to final", async () => {
    const livePart: RunningToolPart = {
      type: "tool",
      id: "tool-live",
      state: "running",
      toolCallId: "call-live",
      toolName: "bash",
      input: { command: "printf live", description: "Print live output" },
      liveOutput: {
        preview: "FIRST_SENTINEL",
        omittedBytes: 12,
        liveLimitReached: true,
      },
      createdAt: 1,
      startedAt: 2,
    };
    await act(async () => {
      root.render(<ToolCard part={livePart} projectSlug="demo" sessionId="root-1" />);
      await flush();
    });

    const summary = requiredButton(":scope > div > button");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("FIRST_SENTINEL");
    expect(container.textContent).toContain("Live");
    expect(container.textContent).toContain("12 B earlier output omitted");
    expect(container.textContent).toContain("Live preview paused");

    await act(async () => {
      summary.click();
      await flush();
      root.render(<ToolCard
        part={{ ...livePart, liveOutput: { ...livePart.liveOutput!, preview: "SECOND_SENTINEL" } }}
        projectSlug="demo"
        sessionId="root-1"
      />);
      await flush();
    });
    expect(requiredButton(":scope > div > button").getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("SECOND_SENTINEL");

    const { liveOutput: _liveOutput, ...liveBase } = livePart;
    const finalPart: CompletedToolPart = {
      ...liveBase,
      state: "completed",
      result: {
        isError: false,
        output: {
          preview: "FINAL_SENTINEL",
          completeness: "complete",
          observed: { bytes: 14, lines: 1 },
          canonical: { bytes: 14, lines: 1 },
          stored: { bytes: 14, lines: 1 },
          omitted: { bytes: 0, lines: 0 },
          recovery: { kind: "none" },
        },
        details: {
          process: { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 20 },
        },
      },
      endedAt: 3,
    };
    await act(async () => {
      root.render(<ToolCard part={finalPart} projectSlug="demo" sessionId="root-1" />);
      await flush();
    });
    const finalSummary = requiredButton(":scope > div > button");
    expect(finalSummary).toBe(summary);
    await act(async () => {
      finalSummary.click();
      await flush();
    });
    expect(container.textContent).toContain("FINAL_SENTINEL");
    expect(container.textContent).not.toContain("SECOND_SENTINEL");
    expect(container.querySelector("[data-testid='tool-live-output']")).toBeNull();
  });

  test("reveals a mutation diff hunk with the first ToolCard expansion", async () => {
    await renderExpandedCard();

    const summary = requiredButton(":scope > div > button");
    expect(summary.className).toContain("w-full");
    expect(summary.className).not.toContain("max-w-");
    const detailSurface = container.querySelector<HTMLElement>("[data-tool-detail-surface]");
    expect(detailSurface).not.toBeNull();
    expect(detailSurface?.className).toContain("w-full");
    expect(detailSurface?.className).not.toContain("max-w-[720px]");
    expect(container.textContent).toContain("@@ -1 +1 @@");
    expect(container.textContent).toContain("const value = 'old';");
    expect(container.textContent).toContain("const value = 'new';");
  });

  test("opens persisted ref after refresh, reads next cursor, and searches without requesting a full body", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(url).toEndWith("/api/projects/demo/sessions/root-1/tool-outputs/search");
        expect(JSON.parse(String(init.body))).toEqual({
          outputRef: "abcdefghijklmnopqrstuv",
          pattern: "needle",
          limit: 50,
        });
        return jsonResponse({
          outputRef: "abcdefghijklmnopqrstuv",
          matches: [{
            outputRef: "abcdefghijklmnopqrstuv",
            segment: "full",
            canonicalStart: 7,
            canonicalEnd: 13,
            snippet: "needle",
          }],
          searchCompleteness: "complete",
        });
      }
      if (url.includes("cursor=next_page")) {
        return jsonResponse({
          outputRef: "abcdefghijklmnopqrstuv",
          completeness: "complete",
          records: [{ segment: "full", canonicalStart: 6, canonicalEnd: 12, text: "world", continuedFromPrevious: false, continuesNext: false }],
        });
      }
      expect(url).toContain("/api/projects/demo/sessions/root-1/tool-outputs/abcdefghijklmnopqrstuv");
      expect(url).toContain("limit=200");
      return jsonResponse({
        outputRef: "abcdefghijklmnopqrstuv",
        completeness: "complete",
        records: [{ segment: "full", canonicalStart: 0, canonicalEnd: 5, text: "hello", continuedFromPrevious: false, continuesNext: true }],
        nextCursor: "next_page",
      });
    });

    await renderExpandedCard();
    expect(container.textContent).not.toContain("Edit applied successfully");

    const openButton = requiredButton('[data-testid="tool-output-open"]');
    await act(async () => { openButton.click(); await flush(); });
    expect(container.querySelector('[data-testid="tool-output-viewer"]')).not.toBeNull();
    expect(container.textContent).toContain("hello");

    const continueButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue loading");
    if (!(continueButton instanceof dom.window.HTMLButtonElement)) throw new Error("Missing continue button");
    await act(async () => { continueButton.click(); await flush(); });
    expect(container.textContent).toContain("world");

    const searchInput = container.querySelector('input[placeholder="Search this output"]');
    if (!(searchInput instanceof dom.window.HTMLInputElement)) throw new Error("Missing search input");
    await act(async () => {
      setInputValue(searchInput, "needle");
      await flush();
    });
    expect(searchInput.value).toBe("needle");
    const searchForm = searchInput.closest("form");
    if (!(searchForm instanceof dom.window.HTMLFormElement)) throw new Error("Missing search form");
    await act(async () => {
      searchForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    expect(container.textContent).toContain("needle");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("shows an expired terminal state and never retries automatically", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(
      { error: { code: "TOOL_OUTPUT_EXPIRED", message: "expired" } },
      410,
    ));
    await renderExpandedCard();
    await act(async () => { requiredButton('[data-testid="tool-output-open"]').click(); await flush(); });
    expect(container.querySelector('[data-testid="tool-output-expired"]')).not.toBeNull();
    expect(container.textContent).toContain("This output has expired.");
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

async function renderExpandedCard(): Promise<void> {
  await act(async () => {
    root.render(<ToolCard part={artifactPart} projectSlug="demo" sessionId="root-1" />);
    await flush();
  });
  const summary = container.querySelector(":scope > div > button");
  if (!(summary instanceof dom.window.HTMLButtonElement)) throw new Error("Missing summary button");
  await act(async () => { summary.click(); await flush(); });
}

function requiredButton(selector: string): HTMLButtonElement {
  const button = container.querySelector(selector);
  if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Missing button ${selector}`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const previous = input.value;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  (input as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]
    : undefined;
  props?.onChange?.({ target: input });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
