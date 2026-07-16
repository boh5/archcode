import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CompletedToolPart } from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ToolCard } from "./ToolCard";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

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
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("ToolCard disclosure interaction", () => {
  test("keeps every detail out of collapsed DOM and reveals the same record on click", async () => {
    const part: CompletedToolPart = {
      type: "tool",
      id: "tool-edit",
      state: "completed",
      toolCallId: "call-edit",
      toolName: "file_edit",
      input: { filePath: "/target.ts", edits: [{ oldString: "old", newString: "new" }] },
      output: "Edit applied successfully",
      meta: {
        diffs: {
          files: [{ path: "src/changed.ts", status: "modified", additions: 2, deletions: 1, hunks: [] }],
        },
      },
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
    };

    await act(async () => {
      root.render(<ToolCard part={part} />);
      await Promise.resolve();
    });

    const summaryButton = container.querySelector(":scope > div > button");
    if (!(summaryButton instanceof dom.window.HTMLButtonElement)) throw new Error("Missing ToolCard summary button");
    expect(summaryButton.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("1 file · +2 −1");
    expect(container.textContent).not.toContain("edits:");
    expect(container.textContent).not.toContain("Edit applied successfully");
    expect(container.textContent).not.toContain("src/changed.ts");

    await act(async () => {
      summaryButton.click();
      await Promise.resolve();
    });

    expect(summaryButton.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("edits:");
    expect(container.textContent).toContain("Edit applied successfully");
    expect(container.textContent).toContain("src/changed.ts");
  });
});
