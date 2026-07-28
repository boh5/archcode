import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AssistantOutputPart, SessionMessage } from "@archcode/protocol";
import type { ExecutionWorkstreamSegment } from "../../lib/execution-workstream";
import { ExecutionNavigationRail } from "./ExecutionNavigationRail";

const originals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

function installDom(): void {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost",
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  container = document.getElementById("root") as HTMLDivElement;
  root = createRoot(container);
}

function restoreDom(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

afterEach(() => {
  act(() => root?.unmount());
  dom?.window.close();
  restoreDom();
});

function inputMessage(id: string, text: string): SessionMessage {
  return {
    id,
    role: "user",
    executionId: "execution",
    createdAt: 1_000,
    completedAt: 1_000,
    parts: [{
      id: `${id}:text`,
      type: "text",
      text,
      createdAt: 1_000,
      completedAt: 1_000,
    }],
  };
}

function outputMessage(id: string, text: string): SessionMessage {
  return {
    id,
    role: "assistant",
    executionId: "execution",
    runOrdinal: 0,
    stepId: `step:${id}`,
    outputPhase: "final_answer",
    createdAt: 2_000,
    completedAt: 2_000,
    parts: [{
      id: `${id}:output`,
      type: "assistant-output",
      blockId: `${id}:block`,
      text,
      createdAt: 2_000,
      completedAt: 2_000,
    }],
  };
}

function createSegment(
  ordinal: number,
  request = `Request ${ordinal}`,
  response?: string,
): ExecutionWorkstreamSegment {
  const input = inputMessage(`input-${ordinal}`, request);
  const output = response
    ? outputMessage(`output-${ordinal}`, response)
    : undefined;
  return {
    id: `segment-${ordinal}`,
    executionId: "execution",
    executionNumber: 1,
    inputMessage: input,
    workItems: [],
    ...(output
      ? {
          finalResponse: {
            message: output,
            outputParts: output.parts.filter(
              (part): part is AssistantOutputPart =>
                part.type === "assistant-output",
            ),
          },
        }
      : {}),
    windowStartedAt: 1_000 + ordinal * 3_000,
    windowEndedAt: 3_000 + ordinal * 3_000,
    activeDurationMs: 2_000,
  };
}

describe("ExecutionNavigationRail", () => {
  test("keeps only the latest segment live while navigation is on history", async () => {
    installDom();
    const segment = createSegment(1);
    const latest = createSegment(2);
    await act(async () => root.render(
      <ExecutionNavigationRail
        segments={[segment, latest]}
        currentSegmentId={segment.id}
        running
        left={0}
        visible
        onNavigate={() => {}}
      />,
    ));
    const [historyMarker, latestMarker] = container.querySelectorAll("button");
    await act(async () => historyMarker!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.body.textContent).toContain("Worked for");
    expect(document.body.textContent).not.toContain("Working for");

    await act(async () => {
      historyMarker!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      latestMarker!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Working for");

    await act(async () => root.render(
      <ExecutionNavigationRail
        segments={[segment, latest]}
        currentSegmentId={segment.id}
        running={false}
        left={0}
        visible
        onNavigate={() => {}}
      />,
    ));
    expect(document.body.textContent).toContain("Worked for");
    expect(document.body.textContent).not.toContain("Working for");
  });

  test("uses one accessible marker per input segment for jump, tooltip, and keyboard navigation", async () => {
    installDom();
    const segments = [
      createSegment(1, "Initial request", "Initial response"),
      createSegment(2, "First steer", "First steer response"),
      createSegment(3, "Second steer", "Second steer response"),
    ];
    const navigations: Array<[string, ScrollBehavior]> = [];
    await act(async () => root.render(
      <ExecutionNavigationRail
        segments={segments}
        currentSegmentId={segments[1]!.id}
        running={false}
        left={12}
        visible
        onNavigate={(...navigation) => navigations.push(navigation)}
      />,
    ));

    const markers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "[data-execution-navigation-id]",
      ),
    );
    expect(markers).toHaveLength(3);
    expect(markers.map((marker) => marker.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("Initial request, Initial response"),
      expect.stringContaining("First steer, First steer response"),
      expect.stringContaining("Second steer, Second steer response"),
    ]);
    expect(markers.every((marker) =>
      !marker.getAttribute("aria-label")?.includes("Message ")
    )).toBe(true);
    expect(markers[1]!.getAttribute("aria-current")).toBe("location");
    expect(markers.map((marker) => marker.tabIndex)).toEqual([-1, 0, -1]);

    await act(async () => markers[2]!.click());
    expect(navigations.at(-1)).toEqual([segments[2]!.id, "smooth"]);

    await act(async () => markers[0]!.focus());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent)
      .toContain("Initial request");
    expect(document.body.querySelector('[role="tooltip"]')?.textContent)
      .toContain("Initial response");
    expect(document.body.querySelector('[role="tooltip"]')?.textContent)
      .not.toContain("Message 1");
    expect(markers[0]!.getAttribute("aria-describedby")).not.toBeNull();

    await act(async () => {
      markers[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowDown",
      }));
      await Promise.resolve();
    });
    expect(navigations.at(-1)).toEqual([segments[1]!.id, "smooth"]);
    expect(document.activeElement).toBe(markers[1]);
  });

  test("caps the tooltip at one request line, three response lines, and one duration line", async () => {
    installDom();
    const segment = createSegment(
      1,
      "A user request long enough that it would otherwise wrap onto another visual line",
      "An Assistant response long enough that it would otherwise occupy several visual lines in the navigation tooltip",
    );
    await act(async () => root.render(
      <ExecutionNavigationRail
        segments={[segment]}
        currentSegmentId={segment.id}
        running={false}
        left={12}
        visible
        onNavigate={() => {}}
      />,
    ));

    const marker = container.querySelector<HTMLButtonElement>(
      "[data-execution-navigation-id]",
    );
    if (!marker) throw new Error("Missing execution navigation marker");
    await act(async () =>
      marker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    );

    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    const rows = Array.from(
      tooltip?.querySelectorAll<HTMLElement>("[data-execution-tooltip-row]")
        ?? [],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.dataset.executionTooltipRow)).toEqual([
      "request",
      "response",
      "duration",
    ]);
    expect(rows[0]!.classList.contains("truncate")).toBe(true);
    expect(rows[1]!.classList.contains("line-clamp-3")).toBe(true);
    expect(rows[1]!.classList.contains("max-h-12")).toBe(true);
    expect(rows[2]!.classList.contains("truncate")).toBe(true);
    expect(tooltip?.classList.contains("overflow-hidden")).toBe(true);
  });

  test("keeps the current marker visible when a long rail is resized", async () => {
    installDom();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    const segments = Array.from({ length: 24 }, (_, index) =>
      createSegment(index + 1));
    await act(async () => root.render(
      <ExecutionNavigationRail
        segments={segments}
        currentSegmentId={segments.at(-1)!.id}
        running={false}
        left={12}
        visible
        onNavigate={() => {}}
      />,
    ));

    const rail = container.querySelector<HTMLElement>(
      '[data-testid="execution-navigation-rail"]',
    );
    const markers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "[data-execution-navigation-id]",
      ),
    );
    if (!rail || markers.length !== segments.length)
      throw new Error("Missing long navigation rail");
    let railHeight = 200;
    Object.defineProperty(rail, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(12, 100, 28, railHeight),
    });
    markers.forEach((marker, index) => {
      Object.defineProperty(marker, "getBoundingClientRect", {
        configurable: true,
        value: () =>
          new dom.window.DOMRect(
            12,
            112 + index * 24 - rail.scrollTop,
            28,
            24,
          ),
      });
    });

    await act(async () => {
      for (const callback of resizeCallbacks)
        callback([], {} as ResizeObserver);
    });
    expect(rail.scrollTop).toBeGreaterThan(0);
    expect(rail.getAttribute("style")).toContain(
      "max-height: min(70vh, 40rem, calc(100% - 16px))",
    );

    const beforeResize = rail.scrollTop;
    railHeight = 80;
    await act(async () => {
      for (const callback of resizeCallbacks)
        callback([], {} as ResizeObserver);
    });
    expect(rail.scrollTop).toBeGreaterThan(beforeResize);
    expect(markers.at(-1)!.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(rail.getBoundingClientRect().bottom - 12);
  });
});
