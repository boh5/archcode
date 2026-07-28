import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionMessage } from "@archcode/protocol";
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

function createSegment(
  ordinal: number,
  request = `Request ${ordinal}`,
): ExecutionWorkstreamSegment {
  const input = inputMessage(`input-${ordinal}`, request);
  return {
    id: `segment-${ordinal}`,
    executionId: "execution",
    executionNumber: 1,
    inputMessages: [input],
    inputMessageIds: [input.id],
    workMessages: [],
    outputMessages: [],
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
      createSegment(1, "Initial request"),
      createSegment(2, "First steer"),
      createSegment(3, "Second steer"),
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
      expect.stringContaining("Message 1, Initial request"),
      expect.stringContaining("Message 2, First steer"),
      expect.stringContaining("Message 3, Second steer"),
    ]);
    expect(markers[1]!.getAttribute("aria-current")).toBe("location");
    expect(markers.map((marker) => marker.tabIndex)).toEqual([-1, 0, -1]);

    await act(async () => markers[2]!.click());
    expect(navigations.at(-1)).toEqual([segments[2]!.id, "smooth"]);

    await act(async () => markers[0]!.focus());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent)
      .toContain("Initial request");
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
