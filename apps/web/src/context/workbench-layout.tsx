import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  WORKBENCH_PREFERENCES_KEY,
  clampInspectorWidth,
  clampSidebarWidth,
  readWorkbenchPreferences,
} from "../lib/workbench-layout";
import { focusElementAfterLayoutChange } from "../lib/focus-control";

export interface WorkbenchLayoutValue {
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  focusMode: boolean;
  mobileNavigationOpen: boolean;
  mobileInspectorOpen: boolean;
  isMobile: boolean;
  inspectorExpanded: boolean;
  mobileInspectorReturnFocusRef: RefObject<HTMLElement | null>;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  toggleInspectorSurface: () => void;
  openInspectorSurface: () => void;
  toggleFocusMode: () => void;
  setMobileNavigationOpen: (open: boolean) => void;
  setMobileInspectorOpen: (open: boolean) => void;
}

export interface WorkbenchPanelSizesValue {
  sidebarWidth: number;
  inspectorWidth: number;
  setSidebarWidth: (width: number) => void;
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
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false
  ));
  const mobileInspectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobileNavigationOpenRef = useRef(mobileNavigationOpen);
  const mobileInspectorOpenRef = useRef(mobileInspectorOpen);
  mobileNavigationOpenRef.current = mobileNavigationOpen;
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
          : mobileNavigationOpenRef.current
            ? 'button[aria-label="Open dashboard"]'
            : null;
        setMobileNavigationOpen(false);
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

  const setSidebarWidth = useCallback((width: number) => setPreferences((current) => ({
    ...current,
    sidebarWidth: clampSidebarWidth(width),
  })), []);
  const setInspectorWidth = useCallback((width: number) => setPreferences((current) => ({
    ...current,
    inspectorWidth: clampInspectorWidth(width),
  })), []);
  const toggleSidebar = useCallback(() => setPreferences((current) => ({
    ...current,
    sidebarCollapsed: !current.sidebarCollapsed,
  })), []);
  const toggleInspector = useCallback(() => setPreferences((current) => ({
    ...current,
    inspectorCollapsed: !current.inspectorCollapsed,
  })), []);
  const toggleFocusMode = useCallback(() => {
    if (!preferences.focusMode) {
      setMobileNavigationOpen(false);
      setMobileInspectorOpen(false);
    }
    setPreferences((current) => ({
      ...current,
      focusMode: !current.focusMode,
    }));
  }, [preferences.focusMode]);
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
      setMobileNavigationOpen(false);
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
      setMobileNavigationOpen(false);
      setMobileInspectorOpen(true);
      return;
    }
    setPreferences((current) => current.inspectorCollapsed
      ? { ...current, inspectorCollapsed: false }
      : current);
  }, [isMobile]);

  const layoutValue = useMemo<WorkbenchLayoutValue>(() => ({
    sidebarCollapsed: preferences.sidebarCollapsed,
    inspectorCollapsed: preferences.inspectorCollapsed,
    focusMode: preferences.focusMode,
    mobileNavigationOpen,
    mobileInspectorOpen,
    isMobile,
    inspectorExpanded: isMobile ? mobileInspectorOpen : !preferences.inspectorCollapsed,
    mobileInspectorReturnFocusRef,
    toggleSidebar,
    toggleInspector,
    toggleInspectorSurface,
    openInspectorSurface,
    toggleFocusMode,
    setMobileNavigationOpen,
    setMobileInspectorOpen: updateMobileInspectorOpen,
  }), [
    isMobile,
    mobileInspectorOpen,
    mobileNavigationOpen,
    preferences.focusMode,
    preferences.inspectorCollapsed,
    preferences.sidebarCollapsed,
    openInspectorSurface,
    toggleFocusMode,
    toggleInspector,
    toggleInspectorSurface,
    toggleSidebar,
    updateMobileInspectorOpen,
  ]);

  const panelSizesValue = useMemo<WorkbenchPanelSizesValue>(() => ({
    sidebarWidth: preferences.sidebarWidth,
    inspectorWidth: preferences.inspectorWidth,
    setSidebarWidth,
    setInspectorWidth,
  }), [preferences.inspectorWidth, preferences.sidebarWidth, setInspectorWidth, setSidebarWidth]);

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

export function useCloseMobileSurfacesOnNavigation(navigationKey: string): void {
  const { setMobileInspectorOpen, setMobileNavigationOpen } = useWorkbenchLayout();
  useEffect(() => {
    setMobileNavigationOpen(false);
    setMobileInspectorOpen(false);
  }, [navigationKey, setMobileInspectorOpen, setMobileNavigationOpen]);
}

function getMobileBreakpointFocusSelector(activeElement: HTMLElement): string | null {
  if (
    activeElement.closest("#context-inspector")
    || activeElement.matches('button[aria-controls~="context-inspector"], [role="separator"][aria-controls="context-inspector"]')
  ) {
    return 'button[aria-label="Open context inspector"]';
  }
  if (
    activeElement.closest('nav[aria-label="Projects"], #project-sidebar')
    || activeElement.matches('button[aria-label="Expand project sidebar"], button[aria-label="Exit focus mode"], [role="separator"][aria-controls="project-sidebar"]')
  ) {
    return 'button[aria-label="Open work navigation"], button[aria-label="Exit focus mode"]';
  }
  return null;
}
