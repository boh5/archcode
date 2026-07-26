import { useSyncExternalStore } from "react";

export type TimeCadence = "second" | "minute";

export interface TimeClockEnvironment {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  isVisible(): boolean;
  subscribeVisibility(listener: () => void): () => void;
  subscribeFocus(listener: () => void): () => void;
}

export interface TimeClockStore {
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
}

export interface TimeClock {
  store(cadence: TimeCadence): TimeClockStore;
}

const CADENCE_MS: Readonly<Record<TimeCadence, number>> = {
  second: 1_000,
  minute: 60_000,
};

function createCadenceStore(
  cadence: TimeCadence,
  environment: TimeClockEnvironment,
): TimeClockStore {
  const listeners = new Set<() => void>();
  let snapshot = environment.now();
  let scheduledHandle: unknown;
  let hasScheduledHandle = false;
  let unsubscribeVisibility: (() => void) | undefined;
  let unsubscribeFocus: (() => void) | undefined;

  const cancelScheduled = (): void => {
    if (!hasScheduledHandle) return;
    environment.cancel(scheduledHandle);
    scheduledHandle = undefined;
    hasScheduledHandle = false;
  };

  const publishFreshSnapshot = (): void => {
    const next = environment.now();
    if (Object.is(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const scheduleNext = (): void => {
    cancelScheduled();
    if (listeners.size === 0 || !environment.isVisible()) return;

    const cadenceMs = CADENCE_MS[cadence];
    const now = environment.now();
    const remainder = ((now % cadenceMs) + cadenceMs) % cadenceMs;
    const delayMs = remainder === 0 ? cadenceMs : cadenceMs - remainder;
    scheduledHandle = environment.schedule(() => {
      hasScheduledHandle = false;
      scheduledHandle = undefined;
      publishFreshSnapshot();
      scheduleNext();
    }, delayMs);
    hasScheduledHandle = true;
  };

  const handleVisibility = (): void => {
    if (!environment.isVisible()) {
      cancelScheduled();
      return;
    }
    publishFreshSnapshot();
    scheduleNext();
  };

  const handleFocus = (): void => {
    publishFreshSnapshot();
    scheduleNext();
  };

  const start = (): void => {
    unsubscribeVisibility = environment.subscribeVisibility(handleVisibility);
    unsubscribeFocus = environment.subscribeFocus(handleFocus);
    // A clock can remain idle for an arbitrary period. Refresh synchronously
    // before scheduling so the first subscriber never observes the idle cache.
    publishFreshSnapshot();
    scheduleNext();
  };

  const stop = (): void => {
    cancelScheduled();
    unsubscribeVisibility?.();
    unsubscribeFocus?.();
    unsubscribeVisibility = undefined;
    unsubscribeFocus = undefined;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}

export function createTimeClock(environment: TimeClockEnvironment): TimeClock {
  const stores: Record<TimeCadence, TimeClockStore> = {
    second: createCadenceStore("second", environment),
    minute: createCadenceStore("minute", environment),
  };

  return {
    store: (cadence) => stores[cadence],
  };
}

function createBrowserEnvironment(): TimeClockEnvironment {
  return {
    now: () => Date.now(),
    schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    subscribeVisibility: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    subscribeFocus: (listener) => {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
  };
}

export const browserTimeClock = createTimeClock(createBrowserEnvironment());

const inactiveSubscribe = (): (() => void) => () => {};
const inactiveSnapshot = (): null => null;

export function useClockSnapshot(
  cadence: TimeCadence,
  active = true,
  clock: TimeClock = browserTimeClock,
): number | null {
  const store = clock.store(cadence);
  return useSyncExternalStore(
    active ? store.subscribe : inactiveSubscribe,
    active ? store.getSnapshot : inactiveSnapshot,
    active ? store.getSnapshot : inactiveSnapshot,
  );
}
