import { describe, expect, test } from "bun:test";

import { AutomationSchema, AutomationStateFileSchema } from "./schema";

describe("automation schemas", () => {
  test("rejects unknown persisted fields at every contract boundary", () => {
    const automation = {
      id: crypto.randomUUID(),
      projectId: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "check",
      trigger: { kind: "interval" as const, everyMs: 30_000 },
      action: { kind: "start_session" as const, message: "Check", location: "project" as const },
      status: "active" as const,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      nextFireAt: "2026-07-13T00:00:30.000Z",
    };
    expect(AutomationSchema.safeParse(automation).success).toBe(true);
    expect(AutomationSchema.safeParse({ ...automation, loopId: "legacy" }).success).toBe(false);
    const { createdFromSessionId: _, ...legacy } = automation;
    expect(AutomationSchema.safeParse(legacy).success).toBe(false);
    expect(AutomationStateFileSchema.safeParse({ version: 1, automations: [automation], invocations: [] }).success).toBe(false);
    expect(AutomationStateFileSchema.safeParse({ version: 2, automations: [automation], invocations: [], loops: [] }).success).toBe(false);
  });
});
