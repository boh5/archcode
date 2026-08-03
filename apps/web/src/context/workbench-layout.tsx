import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  WORKBENCH_PREFERENCES_KEY,
  clampInspectorWidth,
  readWorkbenchPreferences,
} from "../lib/workbench-layout";
import { focusElementAfterLayoutChange } from "../lib/focus-control";

export interface WorkbenchLayoutValue {
  inspectorCollapsed: boolean;
  mobileInspectorOpen: boolean;
  isMobile: boolean;
  inspectorExpanded: boolean;
  mobileInspectorReturnFocusRef: RefObject<HTMLElement | null>;
  toggleInspector: () => void;
  toggleInspectorSurface: () => void;
  openInspectorSurface: () => void;
  setMobileInspectorOpen: (open: boolean) => void;
}

export interface WorkbenchPanelSizesValue {
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
}

const WorkbenchLayoutContext = createContext<WorkbenchLayoutValue | null>(null);
const WorkbenchPanelSizesContext = createContext<WorkbenchPanelSizesValue | null>(null);

export function WorkbenchLayoutProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => {
    try {
      return readWorkbenchPreferences(
        typeof window === "undefined" ? null : window.localStorage.getItem(WORKBENCH_PREFERENCES_KEY),
      );
    } catch {
      return readWorkbenchPreferences(null);
    }
  });
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false
  ));
  const mobileInspectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobileInspectorOpenRef = useRef(mobileInspectorOpen);
  mobileInspectorOpenRef.current = mobileInspectorOpen;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => {
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const mobileFocusSelector = query.matches && activeElement
        ? getMobileBreakpointFocusSelector(activeElement)
        : null;
      setIsMobile(query.matches);
      if (mobileFocusSelector) focusElementAfterLayoutChange(mobileFocusSelector, 2);
      if (!query.matches) {
        const focusSelector = mobileInspectorOpenRef.current
          ? '#context-inspector [role="tab"][tabindex="0"], button[data-state="collapsed"][aria-controls~="context-inspector"]'
          : null;
        setMobileInspectorOpen(false);
        if (focusSelector) focusElementAfterLayoutChange(focusSelector, 2);
      }
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(WORKBENCH_PREFERENCES_KEY, JSON.stringify(preferences));
      } catch {
        // Storage may be unavailable in private or locked-down browser contexts.
      }
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [preferences]);

  const setInspectorWidth = useCallback((width: number) => setPreferences((current) => ({
    ...current,
    inspectorWidth: clampInspectorWidth(width),
  })), []);
  const toggleInspector = useCallback(() => setPreferences((current) => ({
    ...current,
    inspectorCollapsed: !current.inspectorCollapsed,
  })), []);
  const updateMobileInspectorOpen = useCallback((open: boolean) => {
    if (open && document.activeElement instanceof HTMLElement) {
      mobileInspectorReturnFocusRef.current = document.activeElement;
    }
    setMobileInspectorOpen(open);
  }, []);
  const toggleInspectorSurface = useCallback(() => {
    if (isMobile) {
      if (!mobileInspectorOpen && document.activeElement instanceof HTMLElement) {
        mobileInspectorReturnFocusRef.current = document.activeElement;
      }
      setMobileInspectorOpen((open) => !open);
      return;
    }
    toggleInspector();
  }, [isMobile, mobileInspectorOpen, toggleInspector]);
  const openInspectorSurface = useCallback(() => {
    if (isMobile) {
      if (document.activeElement instanceof HTMLElement) {
        mobileInspectorReturnFocusRef.current = document.activeElement;
      }
      setMobileInspectorOpen(true);
      return;
    }
    setPreferences((current) => current.inspectorCollapsed
      ? { ...current, inspectorCollapsed: false }
      : current);
  }, [isMobile]);

  const layoutValue = useMemo<WorkbenchLayoutValue>(() => ({
    inspectorCollapsed: preferences.inspectorCollapsed,
    mobileInspectorOpen,
    isMobile,
    inspectorExpanded: isMobile ? mobileInspectorOpen : !preferences.inspectorCollapsed,
    mobileInspectorReturnFocusRef,
    toggleInspector,
    toggleInspectorSurface,
    openInspectorSurface,
    setMobileInspectorOpen: updateMobileInspectorOpen,
  }), [
    isMobile,
    mobileInspectorOpen,
    preferences.inspectorCollapsed,
    openInspectorSurface,
    toggleInspector,
    toggleInspectorSurface,
    updateMobileInspectorOpen,
  ]);

  const panelSizesValue = useMemo<WorkbenchPanelSizesValue>(() => ({
    inspectorWidth: preferences.inspectorWidth,
    setInspectorWidth,
  }), [preferences.inspectorWidth, setInspectorWidth]);

  return (
    <WorkbenchLayoutContext.Provider value={layoutValue}>
      <WorkbenchPanelSizesContext.Provider value={panelSizesValue}>
        {children}
      </WorkbenchPanelSizesContext.Provider>
    </WorkbenchLayoutContext.Provider>
  );
}

export function useWorkbenchPanelSizes(): WorkbenchPanelSizesValue {
  const value = useContext(WorkbenchPanelSizesContext);
  if (value === null) {
    throw new Error("useWorkbenchPanelSizes must be used inside WorkbenchLayoutProvider");
  }
  return value;
}

export function useWorkbenchLayout(): WorkbenchLayoutValue {
  const value = useContext(WorkbenchLayoutContext);
  if (value === null) {
    throw new Error("useWorkbenchLayout must be used inside WorkbenchLayoutProvider");
  }
  return value;
}

export function useCloseMobileInspectorOnNavigation(navigationKey: string): void {
  const { setMobileInspectorOpen } = useWorkbenchLayout();
  useEffect(() => {
    setMobileInspectorOpen(false);
  }, [navigationKey, setMobileInspectorOpen]);
}

function getMobileBreakpointFocusSelector(activeElement: HTMLElement): string | null {
  if (
    activeElement.closest("#context-inspector")
    || activeElement.matches('button[aria-controls~="context-inspector"], [role="separator"][aria-controls="context-inspector"]')
  ) {
    return 'button[aria-label="Open context inspector"]';
  }
  return null;
}
