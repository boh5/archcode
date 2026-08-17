export const INSPECTOR_DEFAULT_WIDTH = 312;
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 460;
export const WORKBENCH_PREFERENCES_KEY = "archcode.workbench.layout";

export type InspectorKind = "session";

export interface WorkbenchPreferences {
  inspectorWidth: number;
  inspectorCollapsed: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  inspectorCollapsed: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampInspectorWidth(value: number): number {
  return clamp(value, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH);
}

export function getInspectorKind(pathname: string): InspectorKind | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "projects") return null;
  if (segments[2] === "sessions") return "session";
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
      inspectorWidth: typeof parsed.inspectorWidth === "number" && Number.isFinite(parsed.inspectorWidth)
        ? clampInspectorWidth(parsed.inspectorWidth)
        : INSPECTOR_DEFAULT_WIDTH,
      inspectorCollapsed: parsed.inspectorCollapsed === true,
    };
  } catch {
    return DEFAULT_WORKBENCH_PREFERENCES;
  }
}
