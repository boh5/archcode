import { useEffect, useRef, useState, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { WorkSearchResult } from "@archcode/protocol";
import { LoaderCircle, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWorkSearch } from "../../api/queries";

export function WorkSearchDialog({ open, onOpenChange, returnFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const search = useWorkSearch(debouncedQuery);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length === 0) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(normalized), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const isDebouncing = query.trim().length > 0 && query.trim() !== debouncedQuery;
  const resultGroups = search.data ? groupWorkSearchResults(search.data.results) : [];

  const openResult = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-14 z-[71] flex max-h-[min(680px,calc(100dvh-48px))] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[10px] border border-border-strong bg-bg-overlay shadow-lg outline-none"
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border-default px-4 pb-[11px] pt-[14px]">
            <div>
              <DialogPrimitive.Title className="text-[14px] font-semibold leading-5 text-text-primary">Search all work</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-[3px] text-[11px] leading-4 text-text-tertiary">Projects, Todos, Sessions, and Automations</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild><button type="button" aria-label="Close search" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><X size={16} /></button></DialogPrimitive.Close>
          </header>
          <div className="mx-[14px] mb-2 mt-3 grid shrink-0 grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-md border border-border-strong bg-bg-base px-2.5 text-text-tertiary focus-within:border-brand focus-within:[box-shadow:var(--focus)]">
            <Search size={16} className="text-text-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value.slice(0, 200))}
              placeholder="Search by content, stable ID, or source…"
              aria-label="Search all work"
              className="h-[42px] min-w-0 border-0 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted [@media(max-width:640px)]:text-[16px]"
            />
          </div>
          <div className="min-h-[114px] overflow-y-auto px-2 pb-[13px] pt-[3px]" aria-live="polite">
            {!query.trim() ? <p className="px-3 py-7 text-center text-[12px] text-text-tertiary">Search by content, stable ID, or source.</p> : null}
            {isDebouncing || search.isLoading ? <p className="flex items-center justify-center gap-2 px-3 py-12 text-[13px] text-text-tertiary"><LoaderCircle className="animate-activity" size={14} /> Searching…</p> : null}
            {search.error ? <p role="alert" className="px-3 py-4 text-[12px] text-error">Search failed: {search.error.message}</p> : null}
            {search.data?.projectErrors.map((error) => <p role="alert" key={error.project.slug} className="px-3 py-2 text-[11px] text-error">{error.project.name}: {error.message}</p>)}
            {!isDebouncing && query.trim() && search.data && search.data.results.length === 0 ? <p className="px-3 py-12 text-center text-[13px] text-text-tertiary">No work matches “{query.trim()}”.</p> : null}
            {!isDebouncing && resultGroups.map((group) => <section key={group.id} className="[&+&]:mt-[7px]" aria-labelledby={`work-search-group-${group.id}`}>
              <h3 id={`work-search-group-${group.id}`} className="px-2 pb-[5px] pt-[7px] text-[9.5px] font-bold uppercase tracking-[0.08em] text-text-muted">{group.label}</h3>
              {group.results.map((result) => {
                const presentation = presentWorkSearchResult(result);
                return <button
                  key={`${result.kind}:${result.project.slug}:${result.entityId}`}
                  type="button"
                  onClick={() => openResult(result.href)}
                  className="grid min-h-[50px] w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-[9px] rounded-[6px] px-2 py-1.5 text-left text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {result.kind === "project"
                    ? <span className="grid h-[22px] w-[22px] place-items-center rounded-[5px] bg-brand-field font-mono text-[9.5px] font-bold leading-none text-brand" aria-hidden="true">{projectMark(result.project.name)}</span>
                    : <span className={`ml-[7px] h-[7px] w-[7px] rounded-full ${presentation.dot}`} aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-semibold text-text-primary">{result.title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-text-tertiary">{presentation.context}</span>
                  </span>
                  <span className="text-[10px] font-semibold text-text-tertiary">{presentation.state}</span>
                </button>;
              })}
            </section>)}
            {!isDebouncing && search.data?.truncated ? <p className="px-3 py-2 text-[11px] text-text-tertiary">Showing the first 100 results. Refine your search.</p> : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function groupWorkSearchResults(results: readonly WorkSearchResult[]): Array<{ id: string; label: string; results: WorkSearchResult[] }> {
  const groups = new Map<string, { id: string; label: string; results: WorkSearchResult[] }>();
  for (const result of results) {
    const id = result.kind === "project" ? "projects" : result.project.slug;
    const group = groups.get(id) ?? { id, label: result.kind === "project" ? "Projects" : result.project.name, results: [] };
    group.results.push(result);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function presentWorkSearchResult(result: WorkSearchResult): { context: string; state: string; dot: string } {
  if (result.kind === "project") {
    return { context: `Project · ${result.project.slug}`, state: "Project", dot: "bg-text-muted" };
  }
  if (result.kind === "session") {
    const context = `Session${result.context ? ` · ${result.context}` : ""}`;
    return { context, state: "Session", dot: "bg-text-muted" };
  }

  const normalized = result.context?.toLowerCase() ?? "";
  if (result.kind === "automation") {
    const state = normalized === "active"
      ? "Scheduled"
      : normalized === "paused"
        ? "Paused"
        : normalized === "disabled"
          ? "Inactive"
          : "Automation";
    return { context: "Automation", state, dot: "bg-text-muted" };
  }

  const state = normalized === "in_progress"
    ? "In Progress"
    : normalized === "ready"
      ? "Ready"
      : normalized === "done"
        ? "Done"
        : normalized === "rejected"
          ? "Rejected"
          : normalized === "archived"
            ? "Archived"
            : normalized === "idea"
              ? "Idea"
              : "Todo";
  const dot = normalized === "in_progress"
    ? "bg-signal"
    : normalized === "done"
      ? "bg-success"
      : normalized === "ready"
        ? "bg-brand"
        : normalized === "rejected"
          ? "bg-warning"
          : "bg-text-muted";
  return { context: "Todo", state, dot };
}

function projectMark(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toLocaleLowerCase();
}
