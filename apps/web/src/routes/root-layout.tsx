import { Outlet } from "react-router-dom";
import { useAddProjectModal } from "../context/add-project-modal";
import { useSettingsModal } from "../context/settings-modal";
import { ProjectBar } from "../components/features/ProjectBar";
import { Sidebar } from "../components/features/Sidebar";
import { DetailPanel } from "../components/features/DetailPanel";

/**
 * RootLayout — always-visible 4-column grid shell.
 *
 * Grid: 52px | 260px | 1fr | 360px, rows: 48px | 1fr
 * Responsive: ≤1100px hides detail + shrinks sidebar, ≤800px hides projectbar + sidebar + detail
 */
export function RootLayout() {
  const { openAddProjectModal } = useAddProjectModal();
  const { openSettingsModal } = useSettingsModal();

  return (
    <div className="grid h-screen overflow-hidden grid-cols-[52px_260px_1fr_360px] grid-rows-[48px_1fr] max-[1100px]:grid-cols-[52px_220px_1fr_0px] max-[800px]:grid-cols-[0_0_1fr_0]">
      <div className="col-start-2 col-end-5 row-start-1 row-end-2 flex items-center border-b border-border-default px-4">
        <span className="text-sm font-medium text-text-secondary">ArchCode</span>
      </div>

      <div className="col-start-1 col-end-2 row-start-1 row-end-3 min-h-0 overflow-hidden max-[800px]:hidden border-r border-border-default bg-bg-surface">
        <ProjectBar onAddProject={openAddProjectModal} onSettings={openSettingsModal} />
      </div>

      <div className="col-start-2 col-end-3 row-start-2 row-end-3 min-h-0 overflow-hidden max-[800px]:hidden border-r border-border-default bg-bg-surface">
        <Sidebar />
      </div>

      <div className="col-start-3 col-end-4 row-start-2 row-end-3 min-h-0 overflow-hidden">
        <Outlet />
      </div>

      <div className="col-start-4 col-end-5 row-start-2 row-end-3 min-h-0 max-[1100px]:hidden overflow-hidden">
        <DetailPanel />
      </div>
    </div>
  );
}
