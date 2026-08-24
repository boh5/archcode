import { Check, LoaderCircle, Plus, RotateCw } from "lucide-react";
import { Navigate } from "react-router-dom";
import { useEffect } from "react";
import { useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton";
import { useAddProjectModal } from "../context/add-project-modal";

export const LAST_PROJECT_STORAGE_KEY = "archcode.last-project";

export function readLastProjectSlug(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearLastProjectSlug(): void {
  try {
    window.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    // The authoritative project registry remains usable without local preferences.
  }
}

export function resolveRootProject(
  projects: readonly Project[],
  storedSlug: string | null,
): Project | undefined {
  if (storedSlug !== null) {
    const storedProject = projects.find((project) => project.slug === storedSlug);
    if (storedProject !== undefined) return storedProject;
  }
  return projects[0];
}

export function RootEntryRoute() {
  const projectsQuery = useProjects();
  const { openAddProjectModal } = useAddProjectModal();
  const storedSlug = readLastProjectSlug();
  const projects = projectsQuery.data;
  const storedSlugIsValid = projects?.some((project) => project.slug === storedSlug) ?? false;

  useEffect(() => {
    if (projectsQuery.error !== null || projects === undefined || storedSlug === null || storedSlugIsValid) return;
    clearLastProjectSlug();
  }, [projects, projectsQuery.error, storedSlug, storedSlugIsValid]);

  if (projectsQuery.error !== null) {
    return (
      <RootEntryState>
        <div className="mb-5 grid h-12 w-12 place-items-center rounded-[var(--shape-dialog)] border border-error/25 bg-error-field shadow-[var(--elevation-edge)]" aria-hidden="true">
          <RotateCw size={24} className="text-error" />
        </div>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-muted">Project registry</span>
        <h1 id="project-empty-title" className="mb-2.5 mt-2 text-[clamp(25px,3vw,34px)] font-semibold leading-[1.12] tracking-[-0.035em] text-text-primary [@media(max-width:560px)]:text-[26px]">Projects unavailable</h1>
        <p role="alert" className="max-w-[54ch] text-[14.5px] leading-[1.65] text-text-secondary">
          ArchCode could not read the registered projects. Retry without changing your last-project preference.
        </p>
        <button
          type="button"
          className="mt-6 inline-flex min-h-[38px] items-center justify-center gap-2 rounded-[var(--shape-control)] border border-border-default bg-bg-elevated px-3.5 text-[11.5px] font-semibold text-text-primary transition-[background-color,border-color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-color)] disabled:cursor-not-allowed disabled:opacity-50 [@media(max-width:560px)]:min-h-11 [@media(max-width:560px)]:w-full"
          disabled={projectsQuery.isFetching}
          onClick={() => void projectsQuery.refetch()}
        >
          <RotateCw size={14} aria-hidden="true" />
          {projectsQuery.isFetching ? "Retrying…" : "Retry"}
        </button>
      </RootEntryState>
    );
  }

  if (projects === undefined || projectsQuery.isLoading) {
    return (
      <div className="grid h-full min-h-0 place-items-center bg-bg-base px-4" role="status" aria-label="Loading projects">
        <LoaderCircle size={20} className="animate-activity text-text-tertiary" aria-hidden="true" />
      </div>
    );
  }

  const project = resolveRootProject(projects, storedSlug);
  if (project !== undefined) {
    return <Navigate replace to={`/projects/${encodeURIComponent(project.slug)}/todos`} />;
  }

  return (
    <RootEntryState>
      <div className="mb-5 grid h-12 w-12 place-items-center rounded-[var(--shape-dialog)] border border-brand/25 bg-brand-field/60 shadow-[var(--elevation-edge)]" aria-hidden="true">
        <img src="/logo.svg" alt="" width={28} height={28} />
      </div>
      <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-muted">Self-hosted workbench</span>
      <h1 id="project-empty-title" className="mb-2.5 mt-2 text-[clamp(25px,3vw,34px)] font-semibold leading-[1.12] tracking-[-0.035em] text-text-primary [@media(max-width:560px)]:text-[26px]">Open a project to begin</h1>
      <p className="max-w-[54ch] text-[14.5px] leading-[1.65] text-text-secondary">
        Register an existing workspace. ArchCode will open its Todo workspace without creating, cloning, or moving the directory.
      </p>
      <PrimaryActionButton
        type="button"
        aria-haspopup="dialog"
        className="mt-6 px-3.5 min-[761px]:h-[38px] [@media(max-width:560px)]:w-full"
        onClick={openAddProjectModal}
      >
        <Plus size={14} aria-hidden="true" /> Open project
      </PrimaryActionButton>
      <ul className="mt-6 grid list-none gap-2 border-t border-border-subtle pt-4 text-[11.5px] text-text-tertiary" aria-label="Project registration facts">
        <li className="flex items-center gap-2"><Check size={14} className="text-success" aria-hidden="true" /> Your source and Git history stay in place</li>
        <li className="flex items-center gap-2"><Check size={14} className="text-success" aria-hidden="true" /> Runtime data remains local and self-hosted</li>
      </ul>
    </RootEntryState>
  );
}

function RootEntryState({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg-base">
      <section className="mx-auto flex min-h-full w-full max-w-[580px] flex-col items-start justify-center px-5 py-20 [@media(max-width:560px)]:px-4 [@media(max-width:560px)]:py-11" aria-labelledby="project-empty-title">
        {children}
      </section>
    </div>
  );
}
