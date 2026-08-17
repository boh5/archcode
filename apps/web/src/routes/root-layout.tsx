import { useRef, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useStore } from "zustand/react";
import { ProjectBar } from "../components/features/ProjectBar";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { WorkSearchDialog } from "../components/features/WorkSearchDialog";
import { useAddProjectModal } from "../context/add-project-modal";
import { resolveHitlNoticeEntries, useGlobalSSE } from "../context/global-sse";
import { useSettingsModal } from "../context/settings-modal";
import { WorkbenchLayoutProvider, useWorkbenchLayout } from "../context/workbench-layout";
import { useTheme } from "../hooks/use-theme";
import { hitlAttentionPath, hitlStore, scopedHitlIdentity } from "../store/hitl-store";

export function RootLayout() {
  return (
    <WorkbenchLayoutProvider>
      <WorkbenchShell />
    </WorkbenchLayoutProvider>
  );
}

function WorkbenchShell() {
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

      <div className="relative z-[55] w-12 shrink-0 border-r border-rail-border bg-rail min-[721px]:w-[52px] min-[761px]:z-40">
        <ProjectBar
          compactProjectInventory={layout.isProjectInventoryCompact}
          onAddProject={openAddProjectModal}
          onSettings={openSettingsModal}
          onSearch={() => setSearchOpen(true)}
          searchTriggerRef={searchTriggerRef}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      </div>

      <WorkSearchDialog open={searchOpen} onOpenChange={setSearchOpen} returnFocusRef={searchTriggerRef} />

      <main
        id="work-canvas"
        ref={workCanvasRef}
        tabIndex={-1}
        className="relative flex min-w-0 flex-1 flex-col focus:outline-none"
        aria-label="Work canvas"
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>

      {hitlNotices.length > 0 ? (
        <div className="fixed right-4 top-16 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
          {hitlNotices.map((entry) => (
            <Link
              key={scopedHitlIdentity(entry)}
              to={hitlAttentionPath(entry)}
              className="flex items-start gap-2 rounded-lg border border-warning/50 bg-bg-overlay p-3 shadow-md transition-colors duration-[var(--motion-fast)] hover:border-warning hover:bg-bg-hover"
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
      ) : null}
    </div>
  );
}
