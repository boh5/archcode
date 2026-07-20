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

  test("invalidates only Todo caches for the checkpoint-time Todo resource change", () => {
    const calls: unknown[] = [];
    handleSSEEvent({ event: "resource.changed", data: JSON.stringify({
      type: "resource.changed", projectSlug: "demo", resourceType: "todo", resourceId: "t1", createdAt: 1,
    }) }, {
      findStore: () => undefined,
      createStore: (() => { throw new Error("not used"); }) as never,
      invalidateQueries: async ({ queryKey }) => { calls.push(queryKey); },
      onShutdown: () => {}, onHeartbeat: () => {}, refreshMcpStatus: () => {}, requestReconnect: () => {}, refreshSessionSnapshots: () => {},
    });
    expect(calls).toEqual([
      queryKeys.projectTodos("demo"),
      queryKeys.projectTodo("demo", "t1"),
    ]);
    expect(calls).not.toContainEqual(queryKeys.sessions("demo"));
    expect(calls).not.toContainEqual(queryKeys.sessionGoals);
    expect(calls).not.toContainEqual(queryKeys.projectAutomations("demo"));
  });
});
