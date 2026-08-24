import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LoaderCircle, PanelLeftOpen, RotateCw } from "lucide-react";
import { Navigate, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { ContextInspector } from "../components/features/ContextInspector";
import { ProjectTodoCaptureDialog } from "../components/features/ProjectTodoCaptureDialog";
import { ProjectTodoNavigator } from "../components/features/ProjectTodoNavigator";
import { ResizeHandle } from "../components/features/ResizeHandle";
import { useCloseWorkbenchOverlaysOnNavigation, useWorkbenchLayout, useWorkbenchPanelSizes } from "../context/workbench-layout";
import { INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH, getInspectorKind, getWorkbenchSurfaceNavigationKey } from "../lib/workbench-layout";
import { LAST_PROJECT_STORAGE_KEY } from "./root-entry";
import { useProjectTodoNavigation } from "./use-project-todo-navigation";

export type SessionInspectorTopInset = 58 | 108 | 115 | 145;

export interface ProjectLayoutOutletContext {
  readonly setSessionInspectorTopInset: (inset: SessionInspectorTopInset) => void;
}

export function useProjectLayoutOutletContext(): ProjectLayoutOutletContext {
  return useOutletContext<ProjectLayoutOutletContext>();
}

export function ProjectRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <div className="p-4 text-sm text-error">Project is unavailable.</div>;
  return <Navigate replace to={`/projects/${encodeURIComponent(slug)}/todos`} />;
}

export function ProjectLayout() {
  const { slug = "" } = useParams<{ slug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const projectsQuery = useProjects();
  const layout = useWorkbenchLayout();
  const panelSizes = useWorkbenchPanelSizes();
  const navigation = useProjectTodoNavigation(slug, location.pathname);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const [inspectorTopInset, setInspectorTopInset] = useState<SessionInspectorTopInset>(58);
  const newTodoTriggerRef = useRef<HTMLButtonElement | null>(null);
  const captureReturnFocusRef = useRef<HTMLElement | null>(null);
  const project = projectsQuery.data?.find((candidate) => candidate.slug === slug);
  const inspectorKind = getInspectorKind(location.pathname);
  const navigationKey = getWorkbenchSurfaceNavigationKey(location.pathname, location.search);
  useCloseWorkbenchOverlaysOnNavigation(navigationKey);

  useEffect(() => {
    if (project === undefined) return;
    try {
      window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, project.slug);
    } catch {
      // A locked-down browser may make local preferences unavailable.
    }
  }, [project]);

  useEffect(() => {
    if (!savedConfirmation) return;
    const timeout = window.setTimeout(() => setSavedConfirmation(false), 4_000);
    return () => window.clearTimeout(timeout);
  }, [savedConfirmation]);

  useEffect(() => {
    if (inspectorKind === null) setInspectorTopInset(58);
  }, [inspectorKind]);

  const openCapture = useCallback(() => {
    captureReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : newTodoTriggerRef.current;
    setCaptureOpen(true);
  }, []);

  const handleProjectClosed = useCallback((closedProject: Project) => {
    const remaining = projectsQuery.data?.filter((candidate) => candidate.slug !== closedProject.slug) ?? [];
    navigate(remaining[0] ? `/projects/${encodeURIComponent(remaining[0].slug)}/todos` : "/");
  }, [navigate, projectsQuery.data]);

  const outletContext = useMemo<ProjectLayoutOutletContext>(() => ({
    setSessionInspectorTopInset: setInspectorTopInset,
  }), []);

  if (projectsQuery.error !== null) {
    return <ProjectRegistryState><RotateCw size={22} className="text-error" aria-hidden="true" /><h1 className="mt-3 text-[18px] font-semibold text-text-primary">Project unavailable</h1><p role="alert" className="mt-1 max-w-[48ch] text-center text-[13px] leading-5 text-text-secondary">ArchCode could not verify this project. Retry without leaving the current URL.</p><button type="button" disabled={projectsQuery.isFetching} className="mt-4 inline-flex h-9 items-center gap-2 rounded-[var(--shape-card)] bg-brand px-3 text-[12px] font-semibold text-brand-ink focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-50" onClick={() => void projectsQuery.refetch()}><RotateCw size={14} aria-hidden="true" /> {projectsQuery.isFetching ? "Retrying…" : "Retry"}</button></ProjectRegistryState>;
  }

  if (projectsQuery.isLoading || projectsQuery.data === undefined) {
    return <ProjectRegistryState><LoaderCircle size={20} className="animate-activity text-text-tertiary" aria-hidden="true" /><span className="sr-only">Loading project</span></ProjectRegistryState>;
  }

  if (project === undefined) {
    return <UnknownProjectRedirect slug={slug} />;
  }

  return (
    <div className="relative flex h-full min-w-0 overflow-hidden bg-bg-base">
      {!layout.isNavigatorDrawer ? <ProjectTodoNavigator project={project} projection={navigation.projection} newTodoTriggerRef={newTodoTriggerRef} retrying={navigation.retrying} onNewTodo={openCapture} onProjectClosed={handleProjectClosed} onRetry={navigation.retry} /> : <><button type="button" aria-label="Open navigation" aria-expanded={layout.navigatorDrawerOpen} aria-controls="project-todo-drawer" className="absolute left-[9px] top-2 z-30 grid h-[34px] w-[34px] place-items-center rounded-[var(--shape-control)] text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[561px]:top-3 min-[721px]:left-[18px] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={layout.openNavigatorDrawer}><PanelLeftOpen size={15} aria-hidden="true" /></button><ProjectNavigatorDrawer open={layout.navigatorDrawerOpen} onClose={layout.closeNavigatorDrawer}><ProjectTodoNavigator project={project} projection={navigation.projection} newTodoTriggerRef={newTodoTriggerRef} retrying={navigation.retrying} onClose={layout.closeNavigatorDrawer} onNewTodo={openCapture} onProjectClosed={handleProjectClosed} onRetry={navigation.retry} /></ProjectNavigatorDrawer></>}

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {savedConfirmation ? <p role="status" aria-live="polite" className="absolute right-3 top-3 z-40 rounded-[var(--shape-popover)] border border-success/25 bg-success-muted px-3 py-2 text-[11px] text-success shadow-[var(--elevation-popover)]">Todo saved</p> : null}
        <Outlet context={outletContext} />
      </div>

      {inspectorKind !== null && !layout.isInspectorOverlay && !layout.inspectorCollapsed ? <div data-inspector-placement="sibling" className="relative z-30 flex h-full shrink-0 border-l border-border-default bg-bg-surface" style={{ width: panelSizes.inspectorWidth }}><div className="absolute inset-y-0 -left-1 z-40"><ResizeHandle label="Resize context inspector" controls="context-inspector" value={panelSizes.inspectorWidth} min={INSPECTOR_MIN_WIDTH} max={INSPECTOR_MAX_WIDTH} direction={-1} onChange={panelSizes.setInspectorWidth} /></div><ContextInspector kind={inspectorKind} onClose={layout.toggleInspectorSurface} /></div> : null}

      {inspectorKind !== null && layout.isInspectorOverlay ? <InspectorOverlay kind={inspectorKind} open={layout.inspectorOverlayOpen} topInset={inspectorTopInset} width={panelSizes.inspectorWidth} returnFocusRef={layout.inspectorReturnFocusRef} onClose={layout.closeInspectorOverlay} /> : null}

      <ProjectTodoCaptureDialog slug={slug} open={captureOpen} returnFocusRef={captureReturnFocusRef} onOpenChange={setCaptureOpen} onSaved={() => setSavedConfirmation(true)} />
    </div>
  );
}

function ProjectNavigatorDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const layout = useWorkbenchLayout();
  return <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-y-0 left-12 right-0 z-[48] bg-black/55 min-[761px]:left-[52px]" /><DialogPrimitive.Content id="project-todo-drawer" data-project-todo-drawer aria-describedby={undefined} className="fixed inset-y-0 left-12 z-50 w-[276px] max-w-[calc(100vw-48px)] overflow-hidden border-r border-border-default bg-bg-surface shadow-[var(--elevation-drawer-start)] outline-none min-[761px]:left-[52px] min-[761px]:max-w-[calc(100vw-52px)]" onCloseAutoFocus={(event) => { event.preventDefault(); layout.navigatorDrawerReturnFocusRef.current?.focus(); }}><DialogPrimitive.Title className="sr-only">Todo navigator</DialogPrimitive.Title>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}

function InspectorOverlay({ kind, open, topInset, width, returnFocusRef, onClose }: { kind: "session"; open: boolean; topInset: SessionInspectorTopInset; width: number; returnFocusRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  return <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed bottom-0 left-12 right-0 z-[60] bg-black/55 min-[761px]:left-[52px]" style={{ top: topInset }} /><DialogPrimitive.Content aria-describedby={undefined} data-inspector-placement="overlay" className="fixed bottom-0 right-0 z-[65] overflow-hidden border-l border-border-default bg-bg-surface shadow-[var(--elevation-drawer)] outline-none" style={{ top: topInset, width, maxWidth: "calc(100vw - 48px)" }} onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}><DialogPrimitive.Title className="sr-only">Context inspector</DialogPrimitive.Title><ContextInspector kind={kind} onClose={onClose} /></DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}

function ProjectRegistryState({ children }: { children: ReactNode }) {
  return <div className="grid h-full min-h-0 place-content-center place-items-center bg-bg-base px-4">{children}</div>;
}

function UnknownProjectRedirect({ slug }: { slug: string }) {
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY) === slug) {
        window.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
      }
    } catch {
      // Root entry still resolves from the authoritative project registry.
    }
  }, [slug]);
  return <Navigate replace to="/" />;
}
