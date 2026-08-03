import { useEffect, useRef, useState, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
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

  const openResult = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-[71] flex max-h-[76vh] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-overlay shadow-lg outline-none"
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
        >
          <DialogPrimitive.Title className="sr-only">Search all work</DialogPrimitive.Title>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border-default px-3">
            <Search size={16} className="text-text-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value.slice(0, 200))}
              placeholder="Search projects, Todos, Sessions, and Automations…"
              aria-label="Search all work"
              className="h-11 min-w-0 flex-1 bg-transparent text-[16px] text-text-primary outline-none placeholder:text-text-muted"
            />
            <DialogPrimitive.Close asChild><button type="button" aria-label="Close search" className="flex h-9 w-9 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><X size={16} /></button></DialogPrimitive.Close>
          </div>
          <div className="min-h-[180px] overflow-y-auto p-2" aria-live="polite">
            {!query.trim() ? <p className="px-3 py-12 text-center text-[13px] text-text-tertiary">Search by display label, canonical content, stable ID, or source.</p> : null}
            {isDebouncing || search.isLoading ? <p className="flex items-center justify-center gap-2 px-3 py-12 text-[13px] text-text-tertiary"><LoaderCircle className="animate-activity" size={14} /> Searching…</p> : null}
            {search.error ? <p role="alert" className="px-3 py-4 text-[12px] text-error">Search failed: {search.error.message}</p> : null}
            {search.data?.projectErrors.map((error) => <p role="alert" key={error.project.slug} className="px-3 py-2 text-[11px] text-error">{error.project.name}: {error.message}</p>)}
            {!isDebouncing && query.trim() && search.data && search.data.results.length === 0 ? <p className="px-3 py-12 text-center text-[13px] text-text-tertiary">No work matches “{query.trim()}”.</p> : null}
            {!isDebouncing && search.data?.results.map((result) => (
              <button
                key={`${result.kind}:${result.project.slug}:${result.entityId}`}
                type="button"
                onClick={() => openResult(result.href)}
                className="flex min-h-14 w-full items-center gap-3 rounded-sm px-3 py-2 text-left hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-text-primary">{result.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{result.project.name} · {result.kind} · {result.entityId}{result.context ? ` · ${result.context}` : ""}</span>
                </span>
              </button>
            ))}
            {!isDebouncing && search.data?.truncated ? <p className="px-3 py-2 text-[11px] text-text-tertiary">Showing the first 100 results. Refine your search.</p> : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
