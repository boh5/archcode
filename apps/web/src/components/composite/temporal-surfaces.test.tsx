import { afterEach, expect, test } from "bun:test";
import type {
  CompactionPart,
  CompressionBlockPart,
  RecoveryNoticePart,
} from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CompressionBlock } from "./CompressionBlock";
import { PartRenderer } from "./ExecutionWorkstream";
import { RecoveryNotice } from "./RecoveryNotice";

const originalDateNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM | undefined;
let root: Root | undefined;

function installDom(nowRef: { value: number }) {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost",
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLTimeElement: dom.window.HTMLTimeElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Date.now = () => nowRef.value;
  const container = document.getElementById("root") as HTMLDivElement;
  root = createRoot(container);
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  dom?.window.close();
  dom = undefined;
  Date.now = originalDateNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

test("real temporal surfaces cross thresholds and release their shared second scheduler", async () => {
  const now = { value: 159_000 };
  const container = installDom(now);
  const scheduled = new Map<unknown, number>();
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    scheduled.set(handle, delay ?? 0);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof originalClearTimeout>[0]) => {
    if (handle !== undefined) scheduled.delete(handle);
    return originalClearTimeout(handle);
  }) as typeof clearTimeout;

  const compactedAt = 100_000;
  const hardCompact: CompactionPart = {
    type: "compaction",
    id: "hard-compact",
    summary: "Compacted summary",
    tailStartId: "tail",
    compactedAt,
  };
  const dynamicCompression: CompressionBlockPart = {
    type: "compression-block",
    id: "compression:b1",
    blockRef: "b1",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    summary: "Compressed summary",
    startRef: "m0001",
    endRef: "m0004",
    childBlockRefs: [],
    committedAt: compactedAt,
  };
  const scheduledRecovery: RecoveryNoticePart = {
    type: "recovery-notice",
    id: "recovery",
    status: "scheduled",
    message: "Retry scheduled",
    attempt: 1,
    nextRetryAt: 161_000,
    createdAt: 159_000,
  };

  function Surfaces({ recovery }: { recovery: RecoveryNoticePart }) {
    return (
      <>
        <PartRenderer
          part={hardCompact}
          projectSlug="demo"
          focusStoreSessionId="session"
          childSessionLinks={[]}
        />
        <CompressionBlock
          part={dynamicCompression}
          projectSlug="demo"
          sessionId="session"
          focusStoreSessionId="session"
        />
        <RecoveryNotice part={recovery} />
      </>
    );
  }

  await act(async () => root!.render(<Surfaces recovery={scheduledRecovery} />));
  expect([...container.querySelectorAll("time")].map((element) => element.textContent))
    .toEqual(["59s ago", "59s ago"]);
  expect(container.textContent).toContain("retry in 2s");
  expect([...scheduled.values()].filter((delay) => delay <= 1_000)).toHaveLength(1);

  now.value = 160_000;
  await act(async () => window.dispatchEvent(new dom!.window.Event("focus")));
  expect([...container.querySelectorAll("time")].map((element) => element.textContent))
    .toEqual(["1m ago", "1m ago"]);
  expect(container.textContent).toContain("retry in 1s");
  expect([...scheduled.values()].filter((delay) => delay <= 1_000)).toHaveLength(1);

  await act(async () => root!.render(
    <Surfaces recovery={{ ...scheduledRecovery, status: "retrying" }} />,
  ));
  expect(container.textContent).toContain("Retrying");
  expect(container.textContent).not.toContain("retry in");
  expect([...scheduled.values()].filter((delay) => delay <= 1_000)).toHaveLength(0);

  await act(async () => root!.render(<Surfaces recovery={scheduledRecovery} />));
  expect(container.textContent).toContain("retry in 1s");
  expect([...scheduled.values()].filter((delay) => delay <= 1_000)).toHaveLength(1);

  now.value = 161_000;
  await act(async () => window.dispatchEvent(new dom!.window.Event("focus")));
  expect(container.textContent).not.toContain("retry in");
  expect([...scheduled.values()].filter((delay) => delay <= 1_000)).toHaveLength(0);

  await act(async () => root!.unmount());
  root = undefined;
  expect(scheduled.size).toBe(0);
});
