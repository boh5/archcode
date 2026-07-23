import { describe, expect, test } from "bun:test";
import {
  INSPECTOR_DEFAULT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  WORKBENCH_PREFERENCES_KEY,
  clampInspectorWidth,
  clampSidebarWidth,
  getInspectorKind,
  getWorkbenchSurfaceNavigationKey,
  readWorkbenchPreferences,
  resolveInspectorGeometry,
} from "./workbench-layout";

describe("workbench layout", () => {
  test("uses only the current unversioned browser storage key", () => {
    expect(WORKBENCH_PREFERENCES_KEY).toBe("archcode.workbench.layout");
  });

  test("clamps resizable panel widths to their supported ranges", () => {
    expect(clampSidebarWidth(120)).toBe(210);
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(600)).toBe(340);
    expect(clampInspectorWidth(120)).toBe(280);
    expect(clampInspectorWidth(420)).toBe(420);
    expect(clampInspectorWidth(900)).toBe(460);
  });

  test("keeps medium inspector resize semantics aligned with the available canvas", () => {
    expect(resolveInspectorGeometry(460, 320)).toEqual({ value: 320, min: 280, max: 320 });
    expect(resolveInspectorGeometry(280, 240)).toEqual({ value: 240, min: 240, max: 240 });
    expect(resolveInspectorGeometry(330, 800)).toEqual({ value: 330, min: 280, max: 460 });
  });

  test("only object detail routes expose a context inspector", () => {
    expect(getInspectorKind("/")).toBeNull();
    expect(getInspectorKind("/projects/archcode")).toBeNull();
    expect(getInspectorKind("/projects/archcode/sessions/session-1")).toBe("session");
    expect(getInspectorKind("/projects/archcode/goals/goal-1")).toBeNull();
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
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      inspectorCollapsed: false,
      focusMode: false,
    });
    expect(readWorkbenchPreferences("not-json").sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readWorkbenchPreferences(JSON.stringify({ sidebarWidth: null, inspectorWidth: null }))).toEqual({
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      inspectorCollapsed: false,
      focusMode: false,
    });
    expect(readWorkbenchPreferences(JSON.stringify({
      sidebarWidth: 999,
      inspectorWidth: 10,
      sidebarCollapsed: true,
      inspectorCollapsed: "no",
      focusMode: true,
    }))).toEqual({
      sidebarWidth: 340,
      inspectorWidth: 280,
      sidebarCollapsed: true,
      inspectorCollapsed: false,
      focusMode: true,
    });
  });
});
