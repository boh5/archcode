import { describe, expect, test } from "bun:test";
import type { GlobalSSEEvent } from "@archcode/protocol";
import { GlobalEventBus } from "./global-event-bus";

describe("GlobalEventBus", () => {
  test("emits synchronously to current subscribers", () => {
    const bus = new GlobalEventBus();
    const received: GlobalSSEEvent[] = [];

    bus.subscribe((event) => received.push(event));
    bus.emit({ type: "heartbeat", createdAt: 123 });

    expect(received).toEqual([{ type: "heartbeat", createdAt: 123 }]);
  });

  test("unsubscribe prevents further emissions", () => {
    const bus = new GlobalEventBus();
    const received: GlobalSSEEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.emit({ type: "shutdown", reason: "before" });
    unsubscribe();
    bus.emit({ type: "shutdown", reason: "after" });

    expect(received).toEqual([{ type: "shutdown", reason: "before" }]);
  });
});
