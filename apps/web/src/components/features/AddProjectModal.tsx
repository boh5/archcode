import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Folder, LoaderCircle, Search, X } from "lucide-react";
import { useAddProject } from "../../api/mutations";
import { useDirectoryList, useDirectorySearch } from "../../api/queries";
import type { DirectoryEntry } from "../../api/types";

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
}

function isPathLike(input: string): boolean {
  return input.startsWith("/") || input.startsWith("~") || input.startsWith(".");
}

export function AddProjectModal({ open, onClose }: AddProjectModalProps) {
  const navigate = useNavigate();
  const addProject = useAddProject();
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [input, setInput] = useState("");
  const [debouncedInput, setDebouncedInput] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(input), 200);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (open) {
      setInput("");
      setDebouncedInput("");
      setSelectedPath(null);
      setActiveIndex(-1);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const pathMode = isPathLike(debouncedInput);
  const directoryList = useDirectoryList(pathMode ? debouncedInput : "", 50);
  const directorySearch = useDirectorySearch(!pathMode ? debouncedInput : "", 50);

  const candidates: DirectoryEntry[] = pathMode
    ? directoryList.data?.entries ?? []
    : directorySearch.data?.entries ?? [];
  const truncated = pathMode
    ? directoryList.data?.truncated ?? false
    : directorySearch.data?.truncated ?? false;
  const isLoading = pathMode ? directoryList.isLoading : directorySearch.isLoading;
  const hasError = pathMode
    ? !!directoryList.error
    : !!directorySearch.error;

  useEffect(() => {
    setActiveIndex(candidates.length > 0 ? 0 : -1);
  }, [candidates]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) =>
          prev < candidates.length - 1 ? prev + 1 : prev,
        );
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : 0));
        return;
      }

      if (e.key === "Tab" && pathMode && activeIndex >= 0 && activeIndex < candidates.length) {
        e.preventDefault();
        const candidate = candidates[activeIndex];
        setInput(candidate.path + "/");
        setSelectedPath(candidate.path);
        return;
      }

      if (e.key === "Enter" && activeIndex >= 0 && activeIndex < candidates.length) {
        e.preventDefault();
        const candidate = candidates[activeIndex];
        setSelectedPath(candidate.path);
        return;
      }
    },
    [onClose, candidates, activeIndex, pathMode],
  );

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const activeEl = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleSubmit = useCallback(() => {
    if (!selectedPath) return;
    addProject.mutate(
      { path: selectedPath },
      {
        onSuccess: (project) => {
          navigate(`/projects/${project.slug}`);
          onClose();
        },
      },
    );
  }, [selectedPath, addProject, navigate, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isPending = addProject.isPending;
  const errorMessage = addProject.error
    ? addProject.error instanceof Error
      ? addProject.error.message
      : "Failed to add project"
    : null;

  const showCandidates = debouncedInput.trim().length > 0;
  const hasCandidates = candidates.length > 0;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh] animate-overlay-enter"
      onClick={handleOverlayClick}
    >
      <div className="flex max-h-[60vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-overlay shadow-lg">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 shrink-0">
          <h2 className="text-[14px] font-semibold leading-5 text-text-primary">
            Add Project
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            aria-label="Close"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="px-4 pt-4 pb-2 shrink-0">
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <Search size={14} className="text-text-muted" aria-hidden="true" />
            </div>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSelectedPath(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search or type a folder path…"
              autoFocus
              className="h-8 w-full rounded-sm border border-border-control bg-bg-base pl-9 pr-3 text-[13px] text-text-primary transition-colors duration-[var(--motion-hover)] placeholder:text-text-muted hover:border-text-secondary focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-subtle"
              disabled={isPending}
            />
            {isLoading && (
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                <LoaderCircle size={14} className="animate-activity text-neutral" aria-label="Loading directories" />
              </div>
            )}
          </div>
        </div>

        {showCandidates && (
          <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
            {!isLoading && !hasError && !hasCandidates && (
              <div className="flex items-center justify-center py-8 text-text-tertiary text-xs">
                No directories found
              </div>
            )}

            {hasError && !isLoading && (
              <div className="flex items-center justify-center py-8 text-error text-xs">
                Failed to load directories
              </div>
            )}

            {hasCandidates && (
              <ul className="space-y-1 py-1">
                {candidates.map((entry, index) => {
                  const isActive = index === activeIndex;
                  const isSelected = entry.path === selectedPath;
                  return (
                    <li key={entry.path}>
                      <button
                        type="button"
                        data-index={index}
                        className={[
                          "flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-[13px] transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
                          isActive
                            ? "bg-bg-hover text-text-primary"
                            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                          isSelected && !isActive
                            ? "ring-1 ring-brand-subtle"
                            : "",
                        ].join(" ")}
                        onClick={() => {
                          setSelectedPath(entry.path);
                          setActiveIndex(index);
                        }}
                        onMouseEnter={() => setActiveIndex(index)}
                      >
                        <Folder size={15} className="shrink-0 text-text-muted" aria-hidden="true" />
                        <span className="truncate font-mono text-[13px]">
                          {entry.path}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {hasCandidates && truncated && (
              <div className="flex items-center justify-center py-2 text-text-tertiary text-[11px]">
                More results available
              </div>
            )}
          </div>
        )}

        {errorMessage && (
          <div className="px-5 py-2 text-xs text-error shrink-0">{errorMessage}</div>
        )}

        <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 shrink-0">
          <div className="text-[11px] text-text-tertiary">
            {selectedPath ? (
              <span className="flex items-center gap-2">
                <Check size={12} className="text-brand" aria-hidden="true" />
                <span className="font-mono truncate max-w-[320px]">
                  {selectedPath}
                </span>
              </span>
            ) : (
              <span>
                {pathMode
                  ? "Type a path to browse directories"
                  : "Type to search for directories"}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-sm bg-bg-active px-4 text-[12px] font-medium text-text-primary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="h-8 rounded-sm bg-brand px-4 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!selectedPath || isPending}
            >
              {isPending ? "Adding…" : "Add Project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
