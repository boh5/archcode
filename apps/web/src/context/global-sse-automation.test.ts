import { describe, expect, test } from "bun:test";
import { handleSSEEvent } from "./global-sse";
import { queryKeys } from "../api/queries";

describe("global SSE Automation invalidation", () => {
  test("invalidates only Automation caches for an Automation resource change", () => {
    const calls: unknown[] = [];
    handleSSEEvent({ event: "resource.changed", data: JSON.stringify({
      type: "resource.changed", projectSlug: "demo", resourceType: "automation", resourceId: "a1", createdAt: 1,
    }) }, {
      findStore: () => undefined,
      createStore: (() => { throw new Error("not used"); }) as never,
      invalidateQueries: async ({ queryKey }) => { calls.push(queryKey); },
      onShutdown: () => {}, onHeartbeat: () => {}, refreshMcpStatus: () => {}, requestReconnect: () => {}, refreshSessionSnapshots: () => {},
    });
    expect(calls).toEqual([
      queryKeys.automation("demo", "a1"),
      queryKeys.automationInvocations("demo", "a1"),
      queryKeys.projectAutomations("demo"),
      queryKeys.activeAutomations,
    ]);
  });
});
