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

export type InspectorPlacement = "mobile" | "overlay" | "sibling";

export function inspectorPlacementForWidth(viewportWidth: number): InspectorPlacement {
  if (viewportWidth <= 760) return "mobile";
  if (viewportWidth <= 1180) return "overlay";
  return "sibling";
}

function WorkbenchShell() {
  const location = useLocation();
  const { openAddProjectModal } = useAddProjectModal();
  const { openSettingsModal } = useSettingsModal();
  const { theme, toggleTheme } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const workCanvasRef = useRef<HTMLElement>(null);
  const layout = useWorkbenchLayout();
  const { hitlNoticeIdentities } = useGlobalSSE();
  const hitlViews = useStore(hitlStore, (state) => state.views);
  const hitlNotices = resolveHitlNoticeEntries(hitlNoticeIdentities, hitlViews);
  const panelSizes = useWorkbenchPanelSizes();
  const viewportWidth = useViewportWidth();
  const inspectorKind = getInspectorKind(location.pathname);
  const inspectorPlacement = inspectorPlacementForWidth(viewportWidth);
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
      <a
        href="#work-canvas"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          workCanvasRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <div className="relative z-[55] w-12 shrink-0 border-r border-rail-border bg-rail min-[761px]:z-40 min-[761px]:w-[52px]">
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

      <main id="work-canvas" ref={workCanvasRef} tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col focus:outline-none" aria-label="Work canvas">
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
        <div
          data-inspector-placement={inspectorPlacement}
          className={inspectorPlacement === "sibling"
            ? "relative z-30 flex h-full shrink-0 flex-col bg-bg-surface"
            : "absolute bottom-0 right-0 top-[116px] z-30 shrink-0 border-l border-border-default bg-bg-surface shadow-lg"
          }
          style={{ width: inspectorGeometry.value }}
        >
          {inspectorPlacement === "sibling" ? (
            <div className="h-[52px] shrink-0 border-b border-border-default bg-bg-surface" aria-hidden="true" />
          ) : null}
          <div className={`relative min-h-0 flex-1 ${inspectorPlacement === "sibling" ? "border-l border-border-default" : ""}`}>
            <div className="absolute inset-y-0 -left-1 z-40">
              <ResizeHandle
                label={inspectorPlacement === "sibling"
                  ? "Resize context inspector"
                  : "Resize context inspector overlay"}
                controls="context-inspector"
                value={inspectorPlacement === "sibling"
                  ? panelSizes.inspectorWidth
                  : inspectorGeometry.value}
                min={inspectorPlacement === "sibling"
                  ? INSPECTOR_MIN_WIDTH
                  : inspectorGeometry.min}
                max={inspectorPlacement === "sibling"
                  ? INSPECTOR_MAX_WIDTH
                  : inspectorGeometry.max}
                direction={-1}
                onChange={inspectorPlacement === "sibling"
                  ? panelSizes.setInspectorWidth
                  : setRenderedInspectorWidth}
              />
            </div>
            {inspectorPlacement === "overlay" ? (
              <button
                type="button"
                aria-label="Close context inspector"
                className="absolute right-2 top-2 z-50 grid h-[34px] w-[34px] place-items-center rounded-sm text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"
                onClick={layout.toggleInspectorSurface}
              >
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
            <ContextInspector key={inspectorKind} kind={inspectorKind} reserveCloseSpace={inspectorPlacement === "overlay"} />
          </div>
        </div>
      )}

      {layout.isMobile && (
        <Drawer
          open={layout.mobileInspectorOpen && inspectorKind !== null}
          label="Context inspector"
          width={inspectorGeometry.value}
          returnFocusRef={layout.mobileInspectorReturnFocusRef}
          onClose={() => layout.setMobileInspectorOpen(false)}
        >
          {inspectorKind && <ContextInspector key={inspectorKind} id="mobile-context-inspector" kind={inspectorKind} reserveCloseSpace />}
        </Drawer>
      )}
    </div>
  );
}

function Drawer({
  open,
  label,
  width,
  returnFocusRef,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  width: number;
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
          className="fixed bottom-0 right-0 top-[88px] z-50 max-w-[calc(100vw-48px)] border-l border-border-default bg-bg-surface shadow-lg outline-none min-[761px]:hidden"
          style={{ width }}
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
              className="absolute right-2 top-2 z-50 grid h-[34px] w-[34px] place-items-center rounded-sm text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
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
