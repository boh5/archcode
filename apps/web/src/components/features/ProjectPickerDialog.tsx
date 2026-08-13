import { Search, X } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import type { Project } from "../../api/types";
import { StatusGlyph } from "../primitives/StatusGlyph";
import {
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../ui/Dialog";

interface ProjectPickerDialogProps {
  activeSlug?: string;
  attentionCounts: Readonly<Record<string, number>>;
  marks: Readonly<Record<string, string>>;
  onOpenChange: (open: boolean) => void;
  onSelect: (slug: string) => void;
  open: boolean;
  projects: readonly Project[];
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  runningCounts: Readonly<Record<string, number>>;
}

export function filterProjectPickerItems(projects: readonly Project[], query: string): readonly Project[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return projects;
  return projects.filter((project) => (
    project.name.toLocaleLowerCase().includes(needle)
      || project.slug.toLocaleLowerCase().includes(needle)
      || project.workspaceRoot.toLocaleLowerCase().includes(needle)
  ));
}

export function ProjectPickerDialog({
  activeSlug,
  attentionCounts,
  marks,
  onOpenChange,
  onSelect,
  open,
  projects,
  returnFocusRef,
  runningCounts,
}: ProjectPickerDialogProps) {
  const [query, setQuery] = useState("");
  const filteredProjects = useMemo(() => filterProjectPickerItems(projects, query), [projects, query]);

  return (
    <DialogRoot open={open} onOpenChange={(nextOpen) => {
      onOpenChange(nextOpen);
      if (!nextOpen) setQuery("");
    }}>
      <DialogContent
        id="project-picker-dialog"
        className="max-h-[min(620px,calc(100vh-32px))] overflow-hidden p-0"
        aria-describedby="project-picker-description"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <div className="border-b border-border-subtle px-4 pb-3 pt-4">
          <DialogTitle className="text-[16px] font-semibold text-text-primary">Projects</DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close project picker"
              className="absolute right-2 top-2 grid h-8 w-8 cursor-pointer place-items-center rounded-sm text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </DialogClose>
          <DialogDescription id="project-picker-description" className="mt-1 text-[12px] text-text-tertiary">
            Open any registered workspace.
          </DialogDescription>
          <label className="relative mt-3 block" htmlFor="project-picker-filter">
            <span className="sr-only">Filter projects</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" size={14} aria-hidden="true" />
            <input
              id="project-picker-filter"
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter projects…"
              className="h-9 w-full rounded-sm border border-border-control bg-bg-elevated pl-9 pr-3 text-[13px] text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
            />
          </label>
        </div>

        <div className="max-h-[440px] overflow-y-auto p-2" data-testid="project-picker">
          {filteredProjects.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-text-tertiary">No projects match this filter.</p>
          ) : (
            <div className="divide-y divide-border-subtle">
              {filteredProjects.map((project) => {
                const isCurrent = project.slug === activeSlug;
                const runningCount = runningCounts[project.slug] ?? 0;
                const attentionCount = attentionCounts[project.slug] ?? 0;
                return (
                  <button
                    key={project.slug}
                    type="button"
                    aria-current={isCurrent ? "page" : undefined}
                    aria-label={`${project.name}${isCurrent ? ", current project" : ""}, ${runningCount} running, ${attentionCount} need you`}
                    className={`grid min-h-[62px] w-full cursor-pointer grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 px-2 py-2 text-left transition-[background-color,transform] duration-[var(--motion-hover)] hover:-translate-y-px hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${isCurrent ? "bg-selection-field" : ""}`}
                    onClick={() => {
                      onSelect(project.slug);
                      onOpenChange(false);
                      setQuery("");
                    }}
                  >
                    <span className={`grid h-8 w-8 place-items-center rounded-sm border text-[12px] font-semibold ${isCurrent ? "border-brand text-brand" : "border-rail-border text-text-secondary"}`} aria-hidden="true">
                      {marks[project.slug]}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-text-primary">{project.name}</span>
                        {isCurrent ? <span className="shrink-0 text-[11px] font-semibold text-brand">Current</span> : null}
                      </span>
                      <span className="mt-1 block truncate font-mono text-[11px] text-text-tertiary">{project.workspaceRoot}</span>
                    </span>
                    <span className="grid justify-items-end gap-1 text-[11px]">
                      <span className={runningCount > 0 ? "flex items-center gap-1 text-signal-foreground" : "text-text-tertiary"}>
                        {runningCount > 0 ? <StatusGlyph kind="running" size={11} /> : null}
                        {runningCount} running
                      </span>
                      <span className={attentionCount > 0 ? "text-warning" : "text-text-tertiary"}>{attentionCount} need you</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
