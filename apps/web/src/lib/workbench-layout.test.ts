import { describe, expect, test } from "bun:test";
import {
  INSPECTOR_DEFAULT_WIDTH,
  WORKBENCH_PREFERENCES_KEY,
  clampInspectorWidth,
  getInspectorKind,
  getWorkbenchSurfaceNavigationKey,
  readWorkbenchPreferences,
} from "./workbench-layout";

describe("workbench layout", () => {
  test("uses the workbench browser storage key", () => {
    expect(WORKBENCH_PREFERENCES_KEY).toBe("archcode.workbench.layout");
  });

  test("clamps the resizable inspector width to its supported range", () => {
    expect(clampInspectorWidth(120)).toBe(280);
    expect(clampInspectorWidth(420)).toBe(420);
    expect(clampInspectorWidth(900)).toBe(460);
  });

  test("only object detail routes expose a context inspector", () => {
    expect(getInspectorKind("/")).toBeNull();
    expect(getInspectorKind("/projects/archcode")).toBeNull();
    expect(getInspectorKind("/projects/archcode/sessions/session-1")).toBe("session");
    expect(getInspectorKind("/projects/archcode/automations/automation-1")).toBeNull();
  });

  test("keeps inspector detail selection from closing mobile workbench surfaces", () => {
    expect(getWorkbenchSurfaceNavigationKey(
      "/projects/archcode/sessions/session-1",
      "?focus=child&message=message-1&inspector=context",
    )).toBe("/projects/archcode/sessions/session-1?focus=child");
    expect(getWorkbenchSurfaceNavigationKey(
      "/projects/archcode/sessions/session-1",
      "?message=message-1&inspector=context",
    )).toBe("/projects/archcode/sessions/session-1");
  });

  test("falls back safely when persisted preferences are missing or malformed", () => {
    expect(readWorkbenchPreferences(null)).toEqual({
      inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
      inspectorCollapsed: false,
    });
    expect(readWorkbenchPreferences("not-json").inspectorWidth).toBe(INSPECTOR_DEFAULT_WIDTH);
    expect(readWorkbenchPreferences(JSON.stringify({ inspectorWidth: null }))).toEqual({
      inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
      inspectorCollapsed: false,
    });
    expect(readWorkbenchPreferences(JSON.stringify({
      inspectorWidth: 10,
      inspectorCollapsed: "no",
    }))).toEqual({
      inspectorWidth: 280,
      inspectorCollapsed: false,
    });
  });
});
