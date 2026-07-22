import { useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Moon, Plus, Settings, Sun } from "lucide-react";
import { useProjects } from "../../api/queries";
import type { Theme } from "../../hooks/use-theme";
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
  theme: Theme;
  toggleTheme: () => void;
}

function getInitials(slug: string): string {
  return slug.slice(0, 2).toLowerCase();
}

export function ProjectBar({ onAddProject, onSettings, showBell = true, theme, toggleTheme }: ProjectBarProps) {
  const navigate = useNavigate();
  const { slug: activeSlug } = useParams<{ slug: string }>();
  const { data: projects } = useProjects();
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
    <nav className="flex h-full flex-col items-center gap-1 overflow-visible py-2" aria-label="Projects">
      <button
        type="button"
        aria-label="Open dashboard"
        className="mb-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-bg-elevated text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
              className={`group relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[13px] font-semibold transition-[background-color,color] duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                isActive
                  ? "bg-brand-muted text-brand"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
              onClick={(e) => handleProjectClick(project.slug, e)}
            >
              {isActive && (
                <div className="absolute -left-2 top-2 bottom-2 w-[3px] rounded-r-sm bg-brand" />
              )}
              {getInitials(project.slug)}
              {attentionCount > 0 && <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[10px] font-semibold leading-[14px] text-bg-base" aria-label={`${attentionCount} requests need attention`}>{attentionCount > 99 ? "99+" : attentionCount}</span>}
              <span
                id={`project-tooltip-${project.slug}`}
                role="tooltip"
                className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-lg border border-border-default bg-bg-overlay px-2 py-1 text-[11px] leading-4 text-text-primary opacity-0 shadow-md transition-opacity duration-[var(--motion-hover)] group-hover:opacity-100 group-focus-visible:opacity-100"
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
        className="group relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[13px] font-semibold text-text-tertiary transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onClick={handleAddProject}
      >
        <Plus size={16} aria-hidden="true" />
        <span role="tooltip" className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-lg border border-border-default bg-bg-overlay px-2 py-1 text-[11px] leading-4 text-text-primary opacity-0 shadow-md transition-opacity duration-[var(--motion-hover)] group-hover:opacity-100 group-focus-visible:opacity-100">
          Open project
        </span>
      </button>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1 pt-2 border-t border-border-subtle mt-2">
        {showBell && <HitlBell />}
        <button
          type="button"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm text-text-tertiary transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          title="Settings"
          aria-label="Settings"
          onClick={handleSettingsClick}
        >
          <Settings size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm text-text-tertiary transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
