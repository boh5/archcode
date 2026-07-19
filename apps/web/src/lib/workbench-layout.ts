export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
export const INSPECTOR_DEFAULT_WIDTH = 360;
export const INSPECTOR_MIN_WIDTH = 300;
export const INSPECTOR_MAX_WIDTH = 560;
export const WORKBENCH_PREFERENCES_KEY = "archcode.workbench.layout";

export type InspectorKind = "session" | "goal";

export interface WorkbenchPreferences {
  sidebarWidth: number;
  inspectorWidth: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  focusMode: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  focusMode: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampSidebarWidth(value: number): number {
  return clamp(value, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
}

export function clampInspectorWidth(value: number): number {
  return clamp(value, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH);
}

export interface InspectorGeometry {
  value: number;
  min: number;
  max: number;
}

export function resolveInspectorGeometry(preferredWidth: number, availableWidth: number): InspectorGeometry {
  const max = Math.min(INSPECTOR_MAX_WIDTH, Math.max(0, Math.floor(availableWidth)));
  const min = Math.min(INSPECTOR_MIN_WIDTH, max);
  return { value: clamp(preferredWidth, min, max), min, max };
}

export function getInspectorKind(pathname: string): InspectorKind | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "projects") return null;
  if (segments[2] === "sessions") return "session";
  if (segments[2] === "goals") return "goal";
  return null;
}

export function getWorkbenchSurfaceNavigationKey(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("message");
  params.delete("inspector");
  const stableSearch = params.toString();
  return stableSearch.length > 0 ? `${pathname}?${stableSearch}` : pathname;
}

export function readWorkbenchPreferences(raw: string | null): WorkbenchPreferences {
  if (raw === null) return DEFAULT_WORKBENCH_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sidebarWidth: typeof parsed.sidebarWidth === "number" && Number.isFinite(parsed.sidebarWidth)
        ? clampSidebarWidth(parsed.sidebarWidth)
        : SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: typeof parsed.inspectorWidth === "number" && Number.isFinite(parsed.inspectorWidth)
        ? clampInspectorWidth(parsed.inspectorWidth)
        : INSPECTOR_DEFAULT_WIDTH,
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      inspectorCollapsed: parsed.inspectorCollapsed === true,
      focusMode: parsed.focusMode === true,
    };
  } catch {
    return DEFAULT_WORKBENCH_PREFERENCES;
  }
}
