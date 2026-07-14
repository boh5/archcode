import { describe, expect, test } from "bun:test";

import {
  AUTOMATION_MESSAGE_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  MIN_AUTOMATION_INTERVAL_MS,
} from "@archcode/protocol";

import {
  AutomationCreateSchema,
  AutomationSchema,
  AutomationStateFileSchema,
  AutomationUpdateSchema,
} from "./schema";

describe("automation schemas", () => {
  test("enforces the canonical create and update limits", () => {
    const valid = {
      name: "n".repeat(AUTOMATION_NAME_MAX_LENGTH),
      trigger: { kind: "cron" as const, expression: "0 9 * * 1", timezone: "A".repeat(AUTOMATION_TIMEZONE_MAX_LENGTH) },
      action: { kind: "start_session" as const, message: "m".repeat(AUTOMATION_MESSAGE_MAX_LENGTH), location: "project" as const },
    };

    expect(AutomationCreateSchema.safeParse({
      ...valid,
      trigger: { kind: "interval", everyMs: MIN_AUTOMATION_INTERVAL_MS },
    }).success).toBe(true);
    expect(AutomationCreateSchema.safeParse({ ...valid, name: `${valid.name}x` }).success).toBe(false);
    expect(AutomationCreateSchema.safeParse({ ...valid, action: { ...valid.action, message: `${valid.action.message}x` } }).success).toBe(false);
    expect(AutomationCreateSchema.safeParse({ ...valid, trigger: { ...valid.trigger, timezone: `${valid.trigger.timezone}x` } }).success).toBe(false);
    expect(AutomationCreateSchema.safeParse({ ...valid, trigger: { kind: "interval", everyMs: MIN_AUTOMATION_INTERVAL_MS - 1 } }).success).toBe(false);
    expect(AutomationUpdateSchema.safeParse({}).success).toBe(false);
    expect(AutomationUpdateSchema.safeParse({ name: "renamed" }).success).toBe(true);
    expect(AutomationUpdateSchema.safeParse({ name: "renamed", legacy: true }).success).toBe(false);
  });

  test("rejects invalid cron syntax and IANA timezones at the schema boundary", () => {
    expect(AutomationUpdateSchema.safeParse({ trigger: { kind: "cron", expression: "invalid", timezone: "UTC" } }).success).toBe(false);
    expect(AutomationUpdateSchema.safeParse({ trigger: { kind: "cron", expression: "0 9 * * 1", timezone: "Not/A_Timezone" } }).success).toBe(false);
  });

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
