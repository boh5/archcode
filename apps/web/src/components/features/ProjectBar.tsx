import { useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Ellipsis, Moon, Plus, Search, Settings, Sun } from "lucide-react";
import { useProjects } from "../../api/queries";
import type { Theme } from "../../hooks/use-theme";
import { useAttentionVisibleScopedHitl } from "../../store/hitl-store";
import { useSessionRuntimeFamilies } from "../../store/session-runtime-store";
import { HitlBell } from "./HitlBell";
import { ProjectActionContextMenu } from "./ProjectActionMenu";
import { EditProjectDialog } from "./EditProjectDialog";
import { CloseProjectDialog } from "./CloseProjectDialog";
import type { Project } from "../../api/types";
import { ProjectPickerDialog } from "./ProjectPickerDialog";

interface ProjectBarProps {
  compactProjectInventory?: boolean;
  onAddProject?: () => void;
  onSettings?: () => void;
  onSearch?: () => void;
  searchTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  showBell?: boolean;
  theme: Theme;
  toggleTheme: () => void;
}

function asciiLetters(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[^a-z]+/g, "");
}

function markSeed(project: Project): string {
  const words = project.name.normalize("NFKD").toLocaleLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`;
  const letters = asciiLetters(`${project.name}${project.slug}`);
  return (letters + "xx").slice(0, 2);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable for the same project set and independent of registry recency ordering. */
export function buildProjectMarks(projects: readonly Project[]): Readonly<Record<string, string>> {
  const marks: Record<string, string> = {};
  const claimed = new Set<string>();
  const stableProjects = [...projects].sort((left, right) => (
    left.slug.localeCompare(right.slug) || left.workspaceRoot.localeCompare(right.workspaceRoot)
  ));

  for (const project of stableProjects) {
    const base = markSeed(project);
    const candidates = [base];
    const offset = stableHash(`${project.slug}\u0000${project.workspaceRoot}`) % (26 * 26);
    for (let step = 0; step < 26 * 26; step += 1) {
      const value = (offset + step) % (26 * 26);
      candidates.push(`${String.fromCharCode(97 + Math.floor(value / 26))}${String.fromCharCode(97 + (value % 26))}`);
    }
    const mark = candidates.find((candidate) => !claimed.has(candidate));
    if (mark === undefined) throw new Error("Project rail supports at most 676 unique project marks");
    claimed.add(mark);
    marks[project.slug] = mark;
  }
  return marks;
}

/** Registration order is the stable navigation order; opening a project never changes it. */
export function orderProjectNavigation(projects: readonly Project[]): readonly Project[] {
  return [...projects].sort((left, right) => (
    left.addedAt.localeCompare(right.addedAt) || left.slug.localeCompare(right.slug)
  ));
}

export function selectRailProjects(projects: readonly Project[], activeSlug: string | undefined, compactProjectInventory: boolean): readonly Project[] {
  const orderedProjects = orderProjectNavigation(projects);
  if (compactProjectInventory) {
    const active = activeSlug === undefined ? undefined : orderedProjects.find((project) => project.slug === activeSlug);
    return active ? [active] : [];
  }
  return orderedProjects.slice(0, 5);
}

export function ProjectBar({ compactProjectInventory = false, onAddProject, onSettings, onSearch, searchTriggerRef, showBell = true, theme, toggleTheme }: ProjectBarProps) {
  const navigate = useNavigate();
  const { slug: activeSlug } = useParams<{ slug: string }>();
  const { data: projects } = useProjects();
  const attentionVisibleHitl = useAttentionVisibleScopedHitl();
  const runtimeFamilies = useSessionRuntimeFamilies();

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const moreProjectsTriggerRef = useRef<HTMLButtonElement>(null);

  const allProjects = useMemo(() => orderProjectNavigation(projects ?? []), [projects]);
  const currentProject = allProjects.find((project) => project.slug === activeSlug);
  const marks = useMemo(() => buildProjectMarks(allProjects), [allProjects]);
  const visibleProjects = selectRailProjects(allProjects, activeSlug, compactProjectInventory);
  const attentionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of attentionVisibleHitl) counts[entry.projectSlug] = (counts[entry.projectSlug] ?? 0) + 1;
    return counts;
  }, [attentionVisibleHitl]);
  const runningCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const family of Object.values(runtimeFamilies)) {
      if (family.activity !== "running" && family.activity !== "resuming" && family.activity !== "stopping") continue;
      counts[family.projectSlug] = (counts[family.projectSlug] ?? 0) + 1;
    }
    return counts;
  }, [runtimeFamilies]);

  const handleProjectClick = (slug: string, e?: React.MouseEvent) => {
    // Ctrl-click / Cmd-click should not navigate — context menu handles it
    if (e && (e.ctrlKey || e.metaKey)) return;
    navigate(`/projects/${slug}/todos`);
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
        const remaining = allProjects.filter((item) => item.slug !== project.slug);
        if (remaining.length > 0) {
          navigate(`/projects/${remaining[0].slug}/todos`);
        } else {
          navigate("/");
        }
      }
    },
    [activeSlug, allProjects, navigate],
  );

  return (
    <nav
      className="flex h-full flex-col items-center gap-2 overflow-visible py-2 text-rail-muted"
      aria-label="Projects"
      data-testid="project-bar"
    >
      {currentProject === undefined ? (
        <span
          aria-label="ArchCode"
          className="mb-0.5 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px] bg-rail-hover text-rail-ink shadow-[inset_0_0_0_1px_var(--rail-border)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <img src="/logo.svg" alt="" width={20} height={20} />
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Open ${currentProject.name} All todos`}
          className="mb-0.5 flex h-[38px] w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] bg-rail-hover text-rail-ink shadow-[inset_0_0_0_1px_var(--rail-border)] transition-colors duration-[var(--motion-fast)] hover:bg-rail-active focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          onClick={() => navigate(`/projects/${currentProject.slug}/todos`)}
        >
          <img src="/logo.svg" alt="" width={20} height={20} />
        </button>
      )}

      {visibleProjects.map((project) => {
        const isActive = project.slug === activeSlug;
        const attentionCount = attentionCounts[project.slug] ?? 0;
        const runningCount = runningCounts[project.slug] ?? 0;
        return (
          <ProjectActionContextMenu
            key={project.slug}
            project={project}
            onEdit={setEditingProject}
            onClose={setClosingProject}
          >
            <button
              type="button"
              aria-label={`Open ${project.name}${isActive ? ", current project" : ""}${attentionCount > 0 ? `, ${attentionCount} need you` : ""}${runningCount > 0 ? `, ${runningCount} running` : ""}`}
              aria-current={isActive ? "page" : undefined}
              aria-describedby={`project-tooltip-${project.slug}`}
              className={`group relative flex h-[38px] w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] text-[12px] font-semibold leading-[1.55] lowercase tracking-[-0.02em] transition-[background-color,color,box-shadow] duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${
                isActive
                  ? "bg-brand-subtle text-brand shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_24%,var(--rail-border))]"
                  : "text-text-secondary hover:bg-rail-hover hover:text-rail-ink dark:text-rail-muted"
              }`}
              onClick={(e) => handleProjectClick(project.slug, e)}
            >
              {isActive && (
                <div className="absolute left-[-6px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-sm bg-brand" />
              )}
              {marks[project.slug]}
              {attentionCount > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full border-2 border-rail bg-warning px-1 text-[9px] font-bold leading-[11px] text-white dark:text-bg-base" aria-hidden="true">{attentionCount > 99 ? "99+" : attentionCount}</span>}
              {runningCount > 0 && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-rail bg-signal" aria-hidden="true" />}
              <span
                id={`project-tooltip-${project.slug}`}
                role="tooltip"
                className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-lg border border-border-default bg-bg-overlay px-2 py-1 text-[11px] leading-4 text-text-primary opacity-0 shadow-md transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                {project.name}
              </span>
            </button>
          </ProjectActionContextMenu>
        );
      })}

      {((compactProjectInventory && allProjects.length > 0) || allProjects.length >= 5) && (
        <button
          ref={moreProjectsTriggerRef}
          type="button"
          aria-label="More projects"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls="project-picker-dialog"
          className={`group relative flex h-[38px] w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] text-rail-muted transition-[background-color,color,box-shadow] duration-[var(--motion-fast)] hover:bg-rail-hover hover:text-rail-ink focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${pickerOpen ? "bg-brand-subtle text-brand shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_24%,var(--rail-border))]" : ""}`}
          onClick={() => setPickerOpen(true)}
        >
          <Ellipsis size={16} aria-hidden="true" />
          <span role="tooltip" className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-md border border-border-default bg-bg-overlay px-2 py-1 text-[11px] leading-4 text-text-primary opacity-0 shadow-md transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-focus-visible:opacity-100">More projects</span>
        </button>
      )}

      <button
        type="button"
        aria-label="Open project"
        className={`group relative flex h-[38px] w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] transition-[background-color,color] duration-[var(--motion-fast)] hover:bg-rail-hover hover:text-rail-ink focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${allProjects.length === 0 ? "bg-brand-field text-brand" : "text-rail-muted"}`}
        onClick={handleAddProject}
      >
        <Plus size={16} aria-hidden="true" />
        <span role="tooltip" className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-lg border border-border-default bg-bg-overlay px-2 py-1 text-[11px] leading-4 text-text-primary opacity-0 shadow-md transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-focus-visible:opacity-100">
          Open project
        </span>
      </button>

      <div className="flex-1" />

      <>
        {allProjects.length > 0 ? (
          <button
            ref={searchTriggerRef}
            type="button"
            className="flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[9px] text-rail-muted transition-[background-color,color] duration-[var(--motion-fast)] hover:bg-rail-hover hover:text-rail-ink focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            title="Search all work"
            aria-label="Search all work"
            onClick={onSearch}
          >
            <Search size={15} aria-hidden="true" />
          </button>
        ) : null}
        {showBell && allProjects.length > 0 ? <HitlBell mobile={compactProjectInventory} variant="rail" /> : null}
        <button
          type="button"
          className="flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[9px] text-rail-muted transition-[background-color,color] duration-[var(--motion-fast)] hover:bg-rail-hover hover:text-rail-ink focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          title="Settings"
          aria-label="Settings"
          onClick={handleSettingsClick}
        >
          <Settings size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[9px] text-rail-muted transition-[background-color,color] duration-[var(--motion-fast)] hover:bg-rail-hover hover:text-rail-ink focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        </button>
      </>

      <ProjectPickerDialog
        activeSlug={activeSlug}
        attentionCounts={attentionCounts}
        marks={marks}
        onOpenChange={setPickerOpen}
        onSelect={(slug) => handleProjectClick(slug)}
        open={pickerOpen}
        projects={allProjects}
        returnFocusRef={moreProjectsTriggerRef}
        runningCounts={runningCounts}
      />

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
