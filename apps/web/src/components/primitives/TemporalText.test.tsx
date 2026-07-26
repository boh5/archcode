import { afterEach, describe, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  createTimeClock,
  type TimeClock,
  type TimeClockEnvironment,
} from "../../lib/time-clock";
import {
  RelativeTime,
  RelativeTimeValue,
  useCountdown,
  useElapsedTime,
  useRelativeTimePresentation,
} from "./TemporalText";

function createControlledClock(initialNow: number): {
  clock: TimeClock;
  setNow(now: number): void;
  setVisible(visible: boolean): void;
  focus(): void;
  tick(): void;
  scheduledCount(): number;
  visibilityListenerCount(): number;
  focusListenerCount(): number;
} {
  let now = initialNow;
  let visible = true;
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  const visibilityListeners = new Set<() => void>();
  const focusListeners = new Set<() => void>();
  const environment: TimeClockEnvironment = {
    now: () => now,
    schedule: (callback) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle;
    },
    cancel: (handle) => scheduled.delete(handle as number),
    isVisible: () => visible,
    subscribeVisibility: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    subscribeFocus: (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
  };
  return {
    clock: createTimeClock(environment),
    setNow: (value) => { now = value; },
    setVisible: (value) => {
      visible = value;
      for (const listener of visibilityListeners) listener();
    },
    focus: () => {
      for (const listener of focusListeners) listener();
    },
    tick: () => {
      expect(scheduled.size).toBe(1);
      const [handle, callback] = [...scheduled.entries()][0]!;
      scheduled.delete(handle);
      callback();
    },
    scheduledCount: () => scheduled.size,
    visibilityListenerCount: () => visibilityListeners.size,
    focusListenerCount: () => focusListeners.size,
  };
}

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
    HTMLTimeElement: dom.window.HTMLTimeElement,
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

describe("TemporalText", () => {
  test("renders semantic relative time and advances without a parent render", async () => {
    installDom();
    const controlled = createControlledClock(100_000);
    await act(async () => {
      root.render(<RelativeTime timestamp={91_000} clock={controlled.clock} className="age" />);
    });

    const time = container.querySelector("time");
    expect(time?.textContent).toBe("just now");
    expect(time?.getAttribute("datetime")).toBe(new Date(91_000).toISOString());
    expect(time?.getAttribute("title")).toBe(new Date(91_000).toLocaleString());
    expect(time?.getAttribute("aria-label")).toBe(
      `just now; ${new Date(91_000).toLocaleString()}`,
    );

    controlled.setNow(101_000);
    await act(async () => controlled.tick());
    expect(time?.textContent).toBe("10s ago");
  });

  test("crosses the recent threshold and swaps cadence without leaking a scheduler", async () => {
    installDom();
    const controlled = createControlledClock(159_000);
    await act(async () => {
      root.render(
        <StrictMode>
          <>
            <RelativeTime timestamp={100_000} clock={controlled.clock} />
            <RelativeTime timestamp={100_000} style="short" clock={controlled.clock} />
          </>
        </StrictMode>,
      );
    });
    expect(container.textContent).toBe("59s agojust now");
    expect(controlled.scheduledCount()).toBe(1);
    expect(controlled.visibilityListenerCount()).toBe(1);
    expect(controlled.focusListenerCount()).toBe(1);

    controlled.setNow(160_000);
    await act(async () => controlled.tick());
    expect(container.textContent).toBe("1m ago1m");
    expect(controlled.scheduledCount()).toBe(1);
    expect(controlled.visibilityListenerCount()).toBe(1);
    expect(controlled.focusListenerCount()).toBe(1);

    await act(async () => root.render(null));
    expect(controlled.scheduledCount()).toBe(0);
    expect(controlled.visibilityListenerCount()).toBe(0);
    expect(controlled.focusListenerCount()).toBe(0);
  });

  test("derives full and short presentation from one paused external-store snapshot", async () => {
    installDom();
    const controlled = createControlledClock(159_000);

    function Probe({ revision }: { revision: number }) {
      const presentation = useRelativeTimePresentation(100_000, controlled.clock);
      return (
        <div data-revision={revision}>
          <span data-full>{presentation.full}</span>
          <RelativeTimeValue timestamp={100_000} text={presentation.short} />
        </div>
      );
    }

    await act(async () => root.render(<Probe revision={0} />));
    expect(container.querySelector("[data-full]")?.textContent).toBe("59s ago");
    expect(container.querySelector("time")?.textContent).toBe("just now");

    await act(async () => controlled.setVisible(false));
    controlled.setNow(160_000);
    await act(async () => root.render(<Probe revision={1} />));
    expect(container.querySelector("[data-full]")?.textContent).toBe("59s ago");
    expect(container.querySelector("time")?.textContent).toBe("just now");

    await act(async () => controlled.setVisible(true));
    expect(container.querySelector("[data-full]")?.textContent).toBe("1m ago");
    expect(container.querySelector("time")?.textContent).toBe("1m");
  });

  test("shares second cadence across elapsed and countdown and unsubscribes at terminal state", async () => {
    installDom();
    const controlled = createControlledClock(100_000);

    function Probe({ active }: { active: boolean }) {
      const elapsed = useElapsedTime({ startedAt: 95_000, active }, controlled.clock);
      const countdown = useCountdown(102_000, active, controlled.clock);
      return <span>{elapsed}|{countdown ?? "done"}</span>;
    }

    await act(async () => root.render(<Probe active />));
    expect(container.textContent).toBe("5s|2s");
    expect(controlled.scheduledCount()).toBe(1);

    controlled.setNow(102_000);
    await act(async () => controlled.tick());
    expect(container.textContent).toBe("7s|done");
    expect(controlled.scheduledCount()).toBe(1);

    await act(async () => root.render(<Probe active={false} />));
    expect(container.textContent).toBe("0s|done");
    expect(controlled.scheduledCount()).toBe(0);
  });

  test("prefers authoritative duration for settled elapsed time", async () => {
    installDom();
    const controlled = createControlledClock(100_000);

    function Probe() {
      return useElapsedTime({
        startedAt: 10_000,
        endedAt: 90_000,
        durationMs: 65_000,
        active: false,
      }, controlled.clock);
    }

    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("1m 5s");
    expect(controlled.scheduledCount()).toBe(0);
  });

  test("countdown releases the second cadence as soon as it reaches zero", async () => {
    installDom();
    const controlled = createControlledClock(100_000);

    function Probe() {
      return useCountdown(101_000, true, controlled.clock) ?? "done";
    }

    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("1s");
    expect(controlled.scheduledCount()).toBe(1);

    controlled.setNow(101_000);
    await act(async () => controlled.tick());
    expect(container.textContent).toBe("done");
    expect(controlled.scheduledCount()).toBe(0);
  });
});
