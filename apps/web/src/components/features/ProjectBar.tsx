import { useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Moon, Plus, Settings, Sun } from "lucide-react";
import { useProjects } from "../../api/queries";
import { useTheme } from "../../hooks/use-theme";
import { useAttentionVisibleScopedHitl } from "../../store/hitl-store";
import { HitlBell } from "./HitlBell";
import { ProjectActionContextMenu } from "./ProjectActionMenu";
import { EditProjectDialog } from "./EditProjectDialog";
import { CloseProjectDialog } from "./CloseProjectDialog";
import type { Project } from "../../api/types";

interface ProjectBarProps {
  onAddProject?: () => void;
  onSettings?: () => void;
  showBell?: boolean;
}

function getInitials(slug: string): string {
  return slug.slice(0, 2).toLowerCase();
}

export function ProjectBar({ onAddProject, onSettings, showBell = true }: ProjectBarProps) {
  const navigate = useNavigate();
  const { slug: activeSlug } = useParams<{ slug: string }>();
  const { data: projects } = useProjects();
  const { theme, toggleTheme } = useTheme();
  const attentionVisibleHitl = useAttentionVisibleScopedHitl();

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);

  const handleProjectClick = (slug: string, e?: React.MouseEvent) => {
    // Ctrl-click / Cmd-click should not navigate — context menu handles it
    if (e && (e.ctrlKey || e.metaKey)) return;
    navigate(`/projects/${slug}`);
  };

  const handleAddProject = () => {
    onAddProject?.();
  };

  const handleSettingsClick = () => {
    onSettings?.();
  };

  const handleProjectClosed = useCallback(
    (project: Project) => {
      if (project.slug === activeSlug) {
        const remaining = projects?.filter((p) => p.slug !== project.slug);
        if (remaining && remaining.length > 0) {
          navigate(`/projects/${remaining[0].slug}`);
        } else {
          navigate("/");
        }
      }
    },
    [activeSlug, projects, navigate],
  );

  return (
    <nav className="flex h-full flex-col items-center gap-0.5 overflow-visible py-2" aria-label="Projects">
      <button
        type="button"
        aria-label="Open dashboard"
        className="mb-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-elevated focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => navigate("/")}
      >
        <img src="/logo.svg" alt="ArchCode" width={20} height={20} />
      </button>

      {projects?.map((project) => {
        const isActive = project.slug === activeSlug;
        const attentionCount = attentionVisibleHitl.filter((entry) => entry.projectSlug === project.slug).length;
        return (
          <ProjectActionContextMenu
            key={project.slug}
            project={project}
            onEdit={setEditingProject}
            onClose={setClosingProject}
          >
            <button
              type="button"
              aria-label={`Open ${project.name}`}
              aria-current={isActive ? "page" : undefined}
              aria-describedby={`project-tooltip-${project.slug}`}
              className={`group w-9 h-9 rounded-md flex items-center justify-center font-semibold text-[13px] cursor-pointer transition-all duration-150 relative shrink-0 ${
                isActive
                  ? "bg-accent-muted text-accent"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
              onClick={(e) => handleProjectClick(project.slug, e)}
            >
              {isActive && (
                <div className="absolute -left-2 top-2 bottom-2 w-[3px] rounded-r-sm bg-accent" />
              )}
              {getInitials(project.slug)}
              {attentionCount > 0 && <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[9px] font-bold text-bg-base" aria-label={`${attentionCount} requests need attention`}>{attentionCount > 99 ? "99+" : attentionCount}</span>}
              <span
                id={`project-tooltip-${project.slug}`}
                role="tooltip"
                className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-sm border border-border-default bg-bg-elevated px-2.5 py-1 text-xs text-text-primary opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
              >
                {project.name}
              </span>
            </button>
          </ProjectActionContextMenu>
        );
      })}

      <button
        type="button"
        aria-label="Open project"
        className="group w-9 h-9 rounded-md flex items-center justify-center font-semibold text-[13px] text-text-tertiary cursor-pointer transition-all duration-150 relative shrink-0 hover:bg-bg-hover hover:text-text-secondary"
        onClick={handleAddProject}
      >
        <Plus size={16} aria-hidden="true" />
        <span role="tooltip" className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-sm border border-border-default bg-bg-elevated px-2.5 py-1 text-xs text-text-primary opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100">
          Open project
        </span>
      </button>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1 pt-2 border-t border-border-subtle mt-2">
        {showBell && <HitlBell />}
        <button
          type="button"
          className="w-8 h-8 rounded-sm flex items-center justify-center text-text-muted cursor-pointer transition-all duration-150 text-[15px] hover:bg-bg-hover hover:text-text-secondary"
          title="Settings"
          aria-label="Settings"
          onClick={handleSettingsClick}
        >
          <Settings size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-sm flex items-center justify-center text-text-muted cursor-pointer transition-all duration-150 text-[15px] hover:bg-bg-hover hover:text-text-secondary"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        </button>
      </div>

      {editingProject && (
        <EditProjectDialog
          open
          onClose={() => setEditingProject(null)}
          project={editingProject}
        />
      )}

      {closingProject && (
        <CloseProjectDialog
          open
          onClose={() => setClosingProject(null)}
          project={closingProject}
          onClosed={handleProjectClosed}
        />
      )}
    </nav>
  );
}
