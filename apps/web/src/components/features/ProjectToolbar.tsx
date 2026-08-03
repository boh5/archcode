import { useCallback, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useProjects } from "../../api/queries";
import type { Project } from "../../api/types";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { EditProjectDialog } from "./EditProjectDialog";
import { ProjectActionDropdown } from "./ProjectActionMenu";

const PROJECT_PAGES = [
  { label: "Todos", segment: "todos" },
  { label: "Automations", segment: "automations" },
  { label: "Sessions", segment: "sessions" },
] as const;

export function ProjectToolbar() {
  const { slug = "", automationId, sessionId, todoId } = useParams<{
    slug: string;
    automationId?: string;
    sessionId?: string;
    todoId?: string;
  }>();
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const project = projects?.find((candidate) => candidate.slug === slug);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);
  const ProjectName = automationId === undefined && sessionId === undefined && todoId === undefined ? "h1" : "p";

  const handleProjectClosed = useCallback((closedProject: Project) => {
    const remaining = projects?.filter((candidate) => candidate.slug !== closedProject.slug) ?? [];
    navigate(remaining[0] ? `/projects/${remaining[0].slug}/todos` : "/");
  }, [navigate, projects]);

  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-border-default bg-bg-surface px-2 min-[761px]:h-12 min-[761px]:flex-nowrap min-[761px]:px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 min-[761px]:max-w-[min(36vw,360px)] min-[761px]:py-0">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-bg-muted text-[11px] font-semibold text-text-secondary" aria-hidden="true">
          {slug.slice(0, 2).toLowerCase()}
        </span>
        <div className="min-w-0">
          <ProjectName className="truncate text-[14px] font-semibold leading-4 text-text-primary">{project?.name ?? slug}</ProjectName>
          {project && <p className="mt-0.5 hidden truncate font-mono text-[10px] leading-3 text-text-tertiary min-[520px]:block">{project.workspaceRoot}</p>}
        </div>
      </div>

      <nav className="order-3 flex h-10 w-full items-stretch [@media(pointer:coarse)]:h-11 min-[761px]:order-none min-[761px]:h-full min-[761px]:w-auto" aria-label="Project pages">
        {PROJECT_PAGES.map((page) => (
          <NavLink
            key={page.segment}
            to={`/projects/${slug}/${page.segment}`}
            className={({ isActive }) => `relative flex min-w-0 flex-1 items-center justify-center px-3 text-[12px] font-semibold transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[761px]:flex-none ${
              isActive ? "text-brand after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-brand" : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            {page.label}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex items-center">
        {project && <ProjectActionDropdown
          project={project}
          onEdit={setEditingProject}
          onClose={setClosingProject}
          trigger={(
            <button
              type="button"
              aria-label="Project actions"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          )}
        />}
      </div>

      {editingProject && <EditProjectDialog open project={editingProject} onClose={() => setEditingProject(null)} />}
      {closingProject && (
        <CloseProjectDialog
          open
          project={closingProject}
          onClose={() => setClosingProject(null)}
          onClosed={handleProjectClosed}
        />
      )}
    </header>
  );
}
