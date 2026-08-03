import { useEffect, useRef, useState, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useStore } from "zustand/react";
import { useAddProjectModal } from "../context/add-project-modal";
import { useSettingsModal } from "../context/settings-modal";
import { WorkbenchLayoutProvider, useCloseMobileInspectorOnNavigation, useWorkbenchLayout, useWorkbenchPanelSizes } from "../context/workbench-layout";
import { ProjectBar } from "../components/features/ProjectBar";
import { WorkSearchDialog } from "../components/features/WorkSearchDialog";
import { ContextInspector } from "../components/features/ContextInspector";
import { ResizeHandle } from "../components/features/ResizeHandle";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { hitlAttentionPath, hitlStore, scopedHitlIdentity } from "../store/hitl-store";
import { resolveHitlNoticeEntries, useGlobalSSE } from "../context/global-sse";
import {
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  getInspectorKind,
  getWorkbenchSurfaceNavigationKey,
  resolveInspectorGeometry,
} from "../lib/workbench-layout";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const layout = useWorkbenchLayout();
  const { hitlNoticeIdentities } = useGlobalSSE();
  const hitlViews = useStore(hitlStore, (state) => state.views);
  const hitlNotices = resolveHitlNoticeEntries(hitlNoticeIdentities, hitlViews);
  const panelSizes = useWorkbenchPanelSizes();
  const viewportWidth = useViewportWidth();
  const inspectorKind = getInspectorKind(location.pathname);
  const showInspector = inspectorKind !== null && !layout.inspectorCollapsed;
  const inspectorGeometry = resolveInspectorGeometry(
    panelSizes.inspectorWidth,
    viewportWidth <= 1180 ? viewportWidth - (layout.isMobile ? 48 : 52) : INSPECTOR_MAX_WIDTH,
  );
  const setRenderedInspectorWidth = (width: number) => {
    panelSizes.setInspectorWidth(Math.min(inspectorGeometry.max, Math.max(inspectorGeometry.min, width)));
  };
  useCloseMobileInspectorOnNavigation(
    getWorkbenchSurfaceNavigationKey(location.pathname, location.search),
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative flex h-screen min-w-0 overflow-hidden bg-bg-base text-text-primary">
      <div className="relative z-[55] w-12 shrink-0 border-r border-border-default bg-rail min-[761px]:z-40 min-[761px]:w-[52px]">
        <ProjectBar
          mobile={layout.isMobile}
          onAddProject={openAddProjectModal}
          onSettings={openSettingsModal}
          onSearch={() => setSearchOpen(true)}
          searchTriggerRef={searchTriggerRef}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      </div>
      <WorkSearchDialog open={searchOpen} onOpenChange={setSearchOpen} returnFocusRef={searchTriggerRef} />

      <main className="relative flex min-w-0 flex-1 flex-col" aria-label="Work canvas">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>

      {hitlNotices.length > 0 && (
        <div className="fixed right-4 top-16 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
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
            className="z-30 hidden shrink-0 bg-bg-surface min-[761px]:block min-[1181px]:h-full max-[1180px]:absolute max-[1180px]:bottom-0 max-[1180px]:right-0 max-[1180px]:top-28 max-[1180px]:shadow-lg"
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
            <ContextInspector key={inspectorKind} kind={inspectorKind} />
          </div>
        </>
      )}

      {layout.isMobile && (
        <Drawer
          open={layout.mobileInspectorOpen && inspectorKind !== null}
          label="Context inspector"
          returnFocusRef={layout.mobileInspectorReturnFocusRef}
          onClose={() => layout.setMobileInspectorOpen(false)}
        >
          {inspectorKind && <ContextInspector key={inspectorKind} id="mobile-context-inspector" kind={inspectorKind} />}
        </Drawer>
      )}
    </div>
  );
}

function Drawer({
  open,
  label,
  returnFocusRef,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
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
          className="fixed inset-y-0 right-0 z-50 w-[min(92vw,360px)] bg-bg-surface shadow-lg outline-none min-[761px]:hidden"
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
              className="absolute left-2 top-2 z-50 flex h-8 w-8 items-center justify-center rounded-sm border border-border-default bg-bg-elevated text-text-secondary hover:text-text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
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
