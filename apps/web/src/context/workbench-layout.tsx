import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  WORKBENCH_PREFERENCES_KEY,
  clampInspectorWidth,
  readWorkbenchPreferences,
} from "../lib/workbench-layout";

export interface WorkbenchLayoutValue {
  inspectorCollapsed: boolean;
  inspectorExpanded: boolean;
  inspectorOverlayOpen: boolean;
  inspectorReturnFocusRef: RefObject<HTMLElement | null>;
  isProjectInventoryCompact: boolean;
  isInspectorOverlay: boolean;
  isNavigatorDrawer: boolean;
  navigatorDrawerOpen: boolean;
  navigatorDrawerReturnFocusRef: RefObject<HTMLElement | null>;
  viewportWidth: number;
  closeNavigatorDrawer: () => void;
  closeInspectorOverlay: () => void;
  openNavigatorDrawer: () => void;
  setNavigatorDrawerOpen: (open: boolean) => void;
  toggleInspector: () => void;
  toggleInspectorSurface: () => void;
  openInspectorSurface: () => void;
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
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === "undefined" ? 1440 : window.innerWidth
  ));
  const [navigatorDrawerOpen, setNavigatorDrawerOpenState] = useState(false);
  const [inspectorOverlayOpen, setInspectorOverlayOpen] = useState(false);
  const viewportWidthRef = useRef(viewportWidth);
  const pendingResponsiveFocusSelectorsRef = useRef<readonly string[] | null>(null);
  const inspectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const navigatorDrawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const isProjectInventoryCompact = viewportWidth <= 760;
  const isNavigatorDrawer = viewportWidth <= 980;
  const isInspectorOverlay = viewportWidth <= 1260;

  useEffect(() => {
    const update = () => {
      const nextWidth = window.innerWidth;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusSelectors = activeElement === null
        ? null
        : getResponsiveSurfaceFocusSelector(viewportWidthRef.current, nextWidth, activeElement);
      viewportWidthRef.current = nextWidth;
      pendingResponsiveFocusSelectorsRef.current = focusSelectors;
      setViewportWidth(nextWidth);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const focusSelectors = pendingResponsiveFocusSelectorsRef.current;
    if (focusSelectors === null) return;
    if ((!isInspectorOverlay && inspectorOverlayOpen) || (!isNavigatorDrawer && navigatorDrawerOpen)) return;
    const target = focusSelectors
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .find((candidate) => candidate !== null);
    if (target === undefined) return;
    pendingResponsiveFocusSelectorsRef.current = null;
    target.focus();
  }, [inspectorOverlayOpen, isInspectorOverlay, isNavigatorDrawer, navigatorDrawerOpen, viewportWidth]);

  useEffect(() => {
    if (isNavigatorDrawer) return;
    setNavigatorDrawerOpenState(false);
  }, [isNavigatorDrawer]);

  useEffect(() => {
    if (isInspectorOverlay) return;
    setInspectorOverlayOpen(false);
  }, [isInspectorOverlay]);

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
  const setNavigatorDrawerOpen = useCallback((open: boolean) => {
    if (open && document.activeElement instanceof HTMLElement) {
      navigatorDrawerReturnFocusRef.current = document.activeElement;
    }
    setNavigatorDrawerOpenState(open);
  }, []);
  const openNavigatorDrawer = useCallback(() => setNavigatorDrawerOpen(true), [setNavigatorDrawerOpen]);
  const closeNavigatorDrawer = useCallback(() => setNavigatorDrawerOpenState(false), []);
  const closeInspectorOverlay = useCallback(() => setInspectorOverlayOpen(false), []);
  const toggleInspectorSurface = useCallback(() => {
    if (isInspectorOverlay) {
      setInspectorOverlayOpen((open) => {
        if (!open && document.activeElement instanceof HTMLElement) {
          inspectorReturnFocusRef.current = document.activeElement;
        }
        return !open;
      });
      return;
    }
    if (preferences.inspectorCollapsed && document.activeElement instanceof HTMLElement) {
      inspectorReturnFocusRef.current = document.activeElement;
    }
    toggleInspector();
  }, [isInspectorOverlay, preferences.inspectorCollapsed, toggleInspector]);
  const openInspectorSurface = useCallback(() => {
    if (isInspectorOverlay) {
      if (!inspectorOverlayOpen && document.activeElement instanceof HTMLElement) {
        inspectorReturnFocusRef.current = document.activeElement;
      }
      setInspectorOverlayOpen(true);
      return;
    }
    if (preferences.inspectorCollapsed && document.activeElement instanceof HTMLElement) {
      inspectorReturnFocusRef.current = document.activeElement;
    }
    setPreferences((current) => current.inspectorCollapsed
      ? { ...current, inspectorCollapsed: false }
      : current);
  }, [inspectorOverlayOpen, isInspectorOverlay, preferences.inspectorCollapsed]);

  const layoutValue = useMemo<WorkbenchLayoutValue>(() => ({
    inspectorCollapsed: preferences.inspectorCollapsed,
    inspectorExpanded: isInspectorOverlay ? inspectorOverlayOpen : !preferences.inspectorCollapsed,
    inspectorOverlayOpen,
    inspectorReturnFocusRef,
    isProjectInventoryCompact,
    isInspectorOverlay,
    isNavigatorDrawer,
    navigatorDrawerOpen,
    navigatorDrawerReturnFocusRef,
    viewportWidth,
    closeNavigatorDrawer,
    closeInspectorOverlay,
    openNavigatorDrawer,
    setNavigatorDrawerOpen,
    toggleInspector,
    toggleInspectorSurface,
    openInspectorSurface,
  }), [
    closeNavigatorDrawer,
    closeInspectorOverlay,
    isProjectInventoryCompact,
    isInspectorOverlay,
    isNavigatorDrawer,
    navigatorDrawerOpen,
    inspectorOverlayOpen,
    openNavigatorDrawer,
    preferences.inspectorCollapsed,
    setNavigatorDrawerOpen,
    openInspectorSurface,
    toggleInspector,
    toggleInspectorSurface,
    viewportWidth,
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

export function useCloseWorkbenchOverlaysOnNavigation(navigationKey: string): void {
  const { closeInspectorOverlay, closeNavigatorDrawer } = useWorkbenchLayout();
  useEffect(() => {
    closeNavigatorDrawer();
    closeInspectorOverlay();
  }, [closeInspectorOverlay, closeNavigatorDrawer, navigationKey]);
}

function getResponsiveSurfaceFocusSelector(
  previousWidth: number,
  nextWidth: number,
  activeElement: HTMLElement,
): readonly string[] | null {
  const navigatorChanged = (previousWidth <= 980) !== (nextWidth <= 980);
  if (navigatorChanged && activeElement.closest("[data-project-todo-drawer], [data-project-todo-navigator]")) {
    return nextWidth <= 980
      ? ['button[aria-controls="project-todo-drawer"]']
      : [
          '[data-project-todo-navigator] a[aria-current="page"]',
          '[data-project-todo-navigator] a[href]',
        ];
  }

  const inspectorChanged = (previousWidth <= 1260) !== (nextWidth <= 1260);
  if (inspectorChanged && activeElement.closest("#context-inspector")) {
    return nextWidth <= 1260
      ? ['button[aria-controls~="context-inspector"]']
      : [
          '#context-inspector [role="tab"][aria-selected="true"]',
          '#context-inspector [role="tab"][tabindex="0"]',
          '#context-inspector [role="tab"]',
          'button[aria-controls~="context-inspector"]',
        ];
  }
  return null;
}
