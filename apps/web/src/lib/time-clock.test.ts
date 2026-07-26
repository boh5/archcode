import { describe, expect, test } from "bun:test";
import {
  createTimeClock,
  type TimeClockEnvironment,
} from "./time-clock";

interface ScheduledTask {
  callback: () => void;
  delayMs: number;
}

function createControlledEnvironment(initialNow: number) {
  let now = initialNow;
  let visible = true;
  let nextHandle = 1;
  const scheduled = new Map<number, ScheduledTask>();
  const visibilityListeners = new Set<() => void>();
  const focusListeners = new Set<() => void>();

  const environment: TimeClockEnvironment = {
    now: () => now,
    schedule: (callback, delayMs) => {
      const handle = nextHandle++;
      scheduled.set(handle, { callback, delayMs });
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
    environment,
    scheduled,
    visibilityListeners,
    focusListeners,
    setNow(value: number) {
      now = value;
    },
    setVisible(value: boolean) {
      visible = value;
      for (const listener of visibilityListeners) listener();
    },
    focus() {
      for (const listener of focusListeners) listener();
    },
    fireOnlyTask() {
      expect(scheduled.size).toBe(1);
      const [handle, task] = [...scheduled.entries()][0]!;
      scheduled.delete(handle);
      task.callback();
    },
  };
}

describe("createTimeClock", () => {
  test("shares one scheduler per cadence and owns it by subscriber count", () => {
    const controlled = createControlledEnvironment(1_250);
    const clock = createTimeClock(controlled.environment);
    const second = clock.store("second");
    const first = second.subscribe(() => {});
    const secondSubscriber = second.subscribe(() => {});

    expect(controlled.scheduled.size).toBe(1);
    expect([...controlled.scheduled.values()][0]?.delayMs).toBe(750);
    expect(controlled.visibilityListeners.size).toBe(1);
    expect(controlled.focusListeners.size).toBe(1);

    first();
    expect(controlled.scheduled.size).toBe(1);
    secondSubscriber();
    expect(controlled.scheduled.size).toBe(0);
    expect(controlled.visibilityListeners.size).toBe(0);
    expect(controlled.focusListeners.size).toBe(0);
  });

  test("keeps snapshots stable between publications and refreshes a clock after idle", () => {
    const controlled = createControlledEnvironment(1_000);
    const clock = createTimeClock(controlled.environment);
    const store = clock.store("second");
    const original = store.getSnapshot();

    controlled.setNow(10_000);
    expect(store.getSnapshot()).toBe(original);

    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    expect(store.getSnapshot()).toBe(10_000);
    expect(notifications).toBe(1);

    controlled.focus();
    expect(store.getSnapshot()).toBe(10_000);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("pauses while hidden and immediately resynchronizes on visibility and focus", () => {
    const controlled = createControlledEnvironment(1_100);
    const clock = createTimeClock(controlled.environment);
    const store = clock.store("second");
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);

    controlled.setVisible(false);
    expect(controlled.scheduled.size).toBe(0);
    controlled.setNow(9_400);
    expect(store.getSnapshot()).toBe(1_100);

    controlled.setVisible(true);
    expect(store.getSnapshot()).toBe(9_400);
    expect(notifications).toBe(1);
    expect(controlled.scheduled.size).toBe(1);

    controlled.setNow(11_250);
    controlled.focus();
    expect(store.getSnapshot()).toBe(11_250);
    expect(notifications).toBe(2);
    expect(controlled.scheduled.size).toBe(1);
    unsubscribe();
  });

  test("publishes ticks and independently schedules second and minute cadence", () => {
    const controlled = createControlledEnvironment(61_250);
    const clock = createTimeClock(controlled.environment);
    const second = clock.store("second");
    const minute = clock.store("minute");
    const unsubscribeSecond = second.subscribe(() => {});
    const unsubscribeMinute = minute.subscribe(() => {});

    expect(controlled.scheduled.size).toBe(2);
    expect([...controlled.scheduled.values()].map((task) => task.delayMs).sort((a, b) => a - b))
      .toEqual([750, 58_750]);

    unsubscribeMinute();
    controlled.setNow(62_000);
    controlled.fireOnlyTask();
    expect(second.getSnapshot()).toBe(62_000);
    expect(controlled.scheduled.size).toBe(1);
    unsubscribeSecond();
  });
});
