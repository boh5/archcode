import { describe, expect, test } from "bun:test";
import {
  INSPECTOR_DEFAULT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  clampInspectorWidth,
  clampSidebarWidth,
  getInspectorKind,
  readWorkbenchPreferences,
  resolveInspectorGeometry,
} from "./workbench-layout";

describe("workbench layout", () => {
  test("clamps resizable panel widths to their supported ranges", () => {
    expect(clampSidebarWidth(120)).toBe(220);
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(600)).toBe(420);
    expect(clampInspectorWidth(120)).toBe(300);
    expect(clampInspectorWidth(420)).toBe(420);
    expect(clampInspectorWidth(900)).toBe(560);
  });

  test("keeps medium inspector resize semantics aligned with the available canvas", () => {
    expect(resolveInspectorGeometry(560, 320)).toEqual({ value: 320, min: 300, max: 320 });
    expect(resolveInspectorGeometry(280, 240)).toEqual({ value: 240, min: 240, max: 240 });
    expect(resolveInspectorGeometry(360, 800)).toEqual({ value: 360, min: 300, max: 560 });
  });

  test("only object detail routes expose a context inspector", () => {
    expect(getInspectorKind("/")).toBeNull();
    expect(getInspectorKind("/projects/archcode")).toBeNull();
    expect(getInspectorKind("/projects/archcode/goals")).toBeNull();
    expect(getInspectorKind("/projects/archcode/sessions/session-1")).toBe("session");
    expect(getInspectorKind("/projects/archcode/goals/goal-1")).toBe("goal");
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
      sidebarWidth: 420,
      inspectorWidth: 300,
      sidebarCollapsed: true,
      inspectorCollapsed: false,
      focusMode: true,
    });
  });
});
