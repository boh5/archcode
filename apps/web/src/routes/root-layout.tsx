import { useEffect, useRef, useState, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Focus, Menu, PanelLeftOpen, PanelRightOpen, X } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useStore } from "zustand/react";
import { useAddProjectModal } from "../context/add-project-modal";
import { useSettingsModal } from "../context/settings-modal";
import { WorkbenchLayoutProvider, useCloseMobileSurfacesOnNavigation, useWorkbenchLayout, useWorkbenchPanelSizes } from "../context/workbench-layout";
import { ProjectBar } from "../components/features/ProjectBar";
import { Sidebar } from "../components/features/Sidebar";
import { ContextInspector } from "../components/features/ContextInspector";
import { ResizeHandle } from "../components/features/ResizeHandle";
import { HitlBell } from "../components/features/HitlBell";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { hitlAttentionPath, hitlStore, scopedHitlIdentity } from "../store/hitl-store";
import { resolveHitlNoticeEntries, useGlobalSSE } from "../context/global-sse";
import {
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  getInspectorKind,
  getWorkbenchSurfaceNavigationKey,
  resolveInspectorGeometry,
} from "../lib/workbench-layout";
import { focusElementAfterLayoutChange } from "../lib/focus-control";
import { useTheme } from "../hooks/use-theme";

export function RootLayout() {
  return (
    <WorkbenchLayoutProvider>
      <WorkbenchShell />
    </WorkbenchLayoutProvider>
  );
}

function WorkbenchShell() {
  const location = useLocation();
  const { openAddProjectModal } = useAddProjectModal();
  const { openSettingsModal } = useSettingsModal();
  const { theme, toggleTheme } = useTheme();
  const layout = useWorkbenchLayout();
  const { hitlNoticeIdentities } = useGlobalSSE();
  const hitlViews = useStore(hitlStore, (state) => state.views);
  const hitlNotices = resolveHitlNoticeEntries(hitlNoticeIdentities, hitlViews);
  const panelSizes = useWorkbenchPanelSizes();
  const viewportWidth = useViewportWidth();
  const inspectorKind = getInspectorKind(location.pathname);
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const hasProject = location.pathname.startsWith("/projects/");
  const showNavigation = !layout.focusMode;
  const showSidebar = showNavigation && hasProject && !layout.sidebarCollapsed;
  const showInspector = inspectorKind !== null && !layout.inspectorCollapsed;
  const desktopNavigationWidth = showNavigation ? 52 + (showSidebar ? panelSizes.sidebarWidth + 8 : 0) : 0;
  const inspectorGeometry = resolveInspectorGeometry(
    panelSizes.inspectorWidth,
    viewportWidth <= 1180 ? viewportWidth - desktopNavigationWidth : INSPECTOR_MAX_WIDTH,
  );
  const setRenderedInspectorWidth = (width: number) => {
    panelSizes.setInspectorWidth(Math.min(inspectorGeometry.max, Math.max(inspectorGeometry.min, width)));
  };
  useCloseMobileSurfacesOnNavigation(
    getWorkbenchSurfaceNavigationKey(location.pathname, location.search),
  );

  const collapseSidebar = () => {
    layout.toggleSidebar();
    focusElementAfterLayoutChange('button[aria-label="Expand project sidebar"]');
  };
  const expandSidebar = () => {
    layout.toggleSidebar();
    focusElementAfterLayoutChange('button[aria-label="Collapse project sidebar"]');
  };
  const enterFocusMode = () => {
    layout.toggleFocusMode();
    focusElementAfterLayoutChange('button[aria-label="Exit focus mode"]');
  };
  const exitFocusMode = () => {
    layout.toggleFocusMode();
    focusElementAfterLayoutChange('button[aria-label="Enter focus mode"]');
  };
  const collapseInspector = () => {
    layout.toggleInspector();
    focusElementAfterLayoutChange('button[data-state="collapsed"][aria-controls~="context-inspector"]');
  };

  return (
    <div className="relative flex h-screen min-w-0 overflow-hidden bg-bg-base text-text-primary">
      {showNavigation && !layout.isMobile && (
        <div className="hidden h-full shrink-0 min-[761px]:flex">
          <div className="relative z-40 w-[52px] shrink-0 border-r border-border-default bg-rail">
            <ProjectBar onAddProject={openAddProjectModal} onSettings={openSettingsModal} theme={theme} toggleTheme={toggleTheme} />
          </div>
          {showSidebar && (
            <>
              <div className="min-w-0 shrink-0 bg-bg-surface" style={{ width: panelSizes.sidebarWidth }}>
                <Sidebar onCollapse={collapseSidebar} onEnterFocusMode={enterFocusMode} />
              </div>
              <ResizeHandle
                label="Resize project sidebar"
                controls="project-sidebar"
                value={panelSizes.sidebarWidth}
                min={SIDEBAR_MIN_WIDTH}
                max={SIDEBAR_MAX_WIDTH}
                direction={1}
                onChange={panelSizes.setSidebarWidth}
              />
            </>
          )}
        </div>
      )}

      {showNavigation && layout.isMobile && (
        <div className="relative z-[55] w-11 shrink-0 border-r border-border-default bg-rail">
          <ProjectBar
            onAddProject={openAddProjectModal}
            onSettings={openSettingsModal}
            showBell={false}
            theme={theme}
            toggleTheme={toggleTheme}
          />
        </div>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col" aria-label="Work canvas">
        <CompactToolbar
          inspectorAvailable={inspectorKind !== null}
          navigationAvailable={hasProject}
          navigationTriggerRef={navigationTriggerRef}
          inspectorTriggerRef={inspectorTriggerRef}
        />
        {hasProject && !showSidebar && !layout.focusMode && (
          <button
            type="button"
            aria-label="Expand project sidebar"
            aria-controls="project-sidebar"
            aria-expanded="false"
            className="absolute left-0 top-12 z-20 hidden h-8 w-6 items-center justify-center rounded-r-sm border border-l-0 border-border-default bg-bg-surface text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand min-[761px]:flex"
            onClick={expandSidebar}
          >
            <PanelLeftOpen size={14} />
          </button>
        )}
        {layout.focusMode && (
          <button
            type="button"
            aria-label="Exit focus mode"
            className="absolute left-0 top-12 z-20 hidden h-8 w-6 items-center justify-center rounded-r-sm border border-l-0 border-border-default bg-bg-surface text-brand hover:text-brand-hover min-[761px]:flex"
            onClick={exitFocusMode}
          >
            <Focus size={14} />
          </button>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>

      {hitlNotices.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
          {hitlNotices.map((entry) => (
            <Link
              key={scopedHitlIdentity(entry)}
              to={hitlAttentionPath(entry)}
              className="flex items-start gap-2 rounded-lg border border-warning/50 bg-bg-overlay p-3 shadow-md transition-colors duration-[var(--motion-hover)] hover:border-warning hover:bg-bg-hover"
              data-testid="hitl-live-toast"
            >
              <StatusGlyph kind="needs_you" size={14} className="mt-1" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-text-primary">{entry.view.displayPayload.title}</span>
                <span className="mt-1 block text-[11px] text-text-tertiary">{entry.projectSlug} · {entry.view.source.type === "ask_user" ? "Question waiting" : "Permission waiting"}</span>
              </span>
              <span className="text-xs font-medium text-brand">Open</span>
            </Link>
          ))}
        </div>
      )}

      {showInspector && inspectorKind && !layout.isMobile && (
        <>
          <div className="hidden min-[1181px]:block">
            <ResizeHandle
              label="Resize context inspector"
              controls="context-inspector"
              value={panelSizes.inspectorWidth}
              min={INSPECTOR_MIN_WIDTH}
              max={INSPECTOR_MAX_WIDTH}
              direction={-1}
              onChange={panelSizes.setInspectorWidth}
            />
          </div>
          <div
            className="z-30 hidden h-full shrink-0 bg-bg-surface min-[761px]:block max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:shadow-lg"
            style={{ width: inspectorGeometry.value }}
          >
            <div className="absolute inset-y-0 left-0 z-40 hidden min-[761px]:block min-[1181px]:hidden">
              <ResizeHandle
                label="Resize context inspector overlay"
                controls="context-inspector"
                value={inspectorGeometry.value}
                min={inspectorGeometry.min}
                max={inspectorGeometry.max}
                direction={-1}
                onChange={setRenderedInspectorWidth}
              />
            </div>
            <ContextInspector key={inspectorKind} kind={inspectorKind} onCollapse={collapseInspector} />
          </div>
        </>
      )}

      {layout.isMobile && (
        <>
          <Drawer
            open={layout.mobileNavigationOpen && !layout.focusMode}
            label="Work navigation"
            side="left"
            offsetForProjectRail
            returnFocusRef={navigationTriggerRef}
            onClose={() => layout.setMobileNavigationOpen(false)}
          >
            {hasProject && <div className="h-full min-w-0 bg-bg-surface"><Sidebar /></div>}
          </Drawer>

          <Drawer
            open={layout.mobileInspectorOpen && inspectorKind !== null}
            label="Context inspector"
            side="right"
            returnFocusRef={layout.mobileInspectorReturnFocusRef}
            onClose={() => layout.setMobileInspectorOpen(false)}
          >
            {inspectorKind && <ContextInspector key={inspectorKind} id="mobile-context-inspector" kind={inspectorKind} />}
          </Drawer>
        </>
      )}
    </div>
  );
}

function CompactToolbar({
  inspectorAvailable,
  navigationAvailable,
  navigationTriggerRef,
  inspectorTriggerRef,
}: {
  inspectorAvailable: boolean;
  navigationAvailable: boolean;
  navigationTriggerRef: RefObject<HTMLButtonElement | null>;
  inspectorTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const layout = useWorkbenchLayout();
  return (
    <div className="hidden h-11 shrink-0 items-center justify-between border-b border-border-default bg-bg-surface px-2 max-[760px]:flex" aria-label="Compact workbench toolbar">
      <button
        ref={navigationTriggerRef}
        type="button"
        aria-label={layout.focusMode ? "Exit focus mode" : "Open work navigation"}
        aria-expanded={layout.mobileNavigationOpen}
        aria-controls="mobile-work-navigation"
        disabled={!navigationAvailable && !layout.focusMode}
        className="flex h-8 w-8 items-center justify-center rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:invisible"
        onClick={() => {
          if (layout.focusMode) layout.toggleFocusMode();
          else {
            layout.setMobileInspectorOpen(false);
            layout.setMobileNavigationOpen(true);
          }
        }}
      >
        {layout.focusMode ? <Focus size={17} /> : <Menu size={17} />}
      </button>
      <span className="text-xs font-semibold text-text-secondary">ArchCode</span>
      <div className="flex items-center gap-1">
        <HitlBell mobile />
        <button
          ref={inspectorTriggerRef}
          type="button"
          aria-label="Open context inspector"
          aria-expanded={layout.mobileInspectorOpen}
          aria-controls="mobile-context-inspector"
          disabled={!inspectorAvailable}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:invisible"
          onClick={() => {
            layout.setMobileNavigationOpen(false);
            layout.setMobileInspectorOpen(true);
          }}
        >
          <PanelRightOpen size={17} />
        </button>
      </div>
    </div>
  );
}

function Drawer({
  open,
  label,
  side,
  offsetForProjectRail = false,
  returnFocusRef,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  side: "left" | "right";
  offsetForProjectRail?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 min-[761px]:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={`fixed inset-y-0 z-50 bg-bg-surface shadow-lg outline-none min-[761px]:hidden ${
            side === "left"
              ? offsetForProjectRail
                ? "left-11 w-[min(calc(92vw-44px),340px)]"
                : "left-0 w-[min(92vw,360px)]"
              : "right-0 w-[min(92vw,360px)]"
          }`}
          id={side === "left" ? "mobile-work-navigation" : undefined}
          onCloseAutoFocus={returnFocusRef ? (event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          } : undefined}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label={`Close ${label}`}
              className={`absolute top-2 z-50 flex h-8 w-8 items-center justify-center rounded-sm border border-border-default bg-bg-elevated text-text-secondary hover:text-text-primary ${side === "left" ? "right-2" : "left-2"}`}
            >
              <X size={16} />
            </button>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}
