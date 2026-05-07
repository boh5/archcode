import { describe, expect, it } from "bun:test";
import type { ToolExecutionContext } from "../types";
import { createPermissionGuard } from "./permission.js";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: {} as ToolExecutionContext["store"],
    toolName: overrides.toolName ?? "rm",
    toolCallId: overrides.toolCallId ?? "call-abc-123",
    input: overrides.input ?? { command: "rm -rf /" },
    step: overrides.step ?? 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    durationMs: overrides.durationMs,
    ...overrides,
  };
}

describe("createPermissionGuard", () => {
  it("returns a BeforeHook function", () => {
    const hook = createPermissionGuard();
    expect(typeof hook).toBe("function");
  });

  it("returns void (no-op) for any input", async () => {
    const hook = createPermissionGuard();
    const ctx = makeCtx({ toolName: "rm", input: { command: "rm -rf /" } });

    const returned = await hook({ command: "rm -rf /" }, ctx);
    expect(returned).toBeUndefined();
  });

  it("does not block destructive tools", async () => {
    const hook = createPermissionGuard();
    const ctx = makeCtx({ toolName: "rm" });

    // Should not throw, not return anything that would block
    const returned = await hook({ path: "/" }, ctx);
    expect(returned).toBeUndefined();
  });

  it("does not read config or filesystem", async () => {
    const hook = createPermissionGuard();
    const ctx = makeCtx();

    // Just verify it doesn't throw
    const returned = await hook("any input", ctx);
    expect(returned).toBeUndefined();
  });

  it("returns void regardless of input type", async () => {
    const hook = createPermissionGuard();

    // Null input
    let returned = await hook(null, makeCtx());
    expect(returned).toBeUndefined();

    // Undefined input
    returned = await hook(undefined, makeCtx());
    expect(returned).toBeUndefined();

    // String input
    returned = await hook("string", makeCtx());
    expect(returned).toBeUndefined();

    // Number input
    returned = await hook(42, makeCtx());
    expect(returned).toBeUndefined();
  });
});
