import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-[2px]"
      onClick={handleOverlayClick}
    >
      <div className="w-[min(560px,92vw)] max-h-[60vh] flex flex-col rounded-lg border border-border-default bg-bg-surface shadow-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5 shrink-0">
          <h2 className="text-sm font-semibold text-text-primary tracking-wide uppercase">
            Add Project
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-4 pt-4 pb-2 shrink-0">
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <svg
                className="h-4 w-4 text-text-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
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
              className="w-full rounded-sm border border-border-default bg-bg-base pl-9 pr-3 py-2.5 text-[13.5px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
              disabled={isPending}
            />
            {isLoading && (
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
              </div>
            )}
          </div>
        </div>

        {showCandidates && (
          <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
            {!isLoading && !hasError && !hasCandidates && (
              <div className="flex items-center justify-center py-8 text-text-muted text-xs">
                No directories found
              </div>
            )}

            {hasError && !isLoading && (
              <div className="flex items-center justify-center py-8 text-error text-xs">
                Failed to load directories
              </div>
            )}

            {hasCandidates && (
              <ul className="space-y-0.5 py-1">
                {candidates.map((entry, index) => {
                  const isActive = index === activeIndex;
                  const isSelected = entry.path === selectedPath;
                  return (
                    <li key={entry.path}>
                      <button
                        type="button"
                        data-index={index}
                        className={[
                          "flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[13px] transition-colors duration-100",
                          isActive
                            ? "bg-bg-hover text-text-primary"
                            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                          isSelected && !isActive
                            ? "ring-1 ring-accent-subtle"
                            : "",
                        ].join(" ")}
                        onClick={() => {
                          setSelectedPath(entry.path);
                          setActiveIndex(index);
                        }}
                        onMouseEnter={() => setActiveIndex(index)}
                      >
                        <svg
                          className="h-4 w-4 shrink-0 text-text-muted"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                          />
                        </svg>
                        <span className="truncate font-mono text-[12.5px]">
                          {entry.path}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {hasCandidates && truncated && (
              <div className="flex items-center justify-center py-2 text-text-muted text-[11px]">
                More results available
              </div>
            )}
          </div>
        )}

        {errorMessage && (
          <div className="px-5 py-2 text-xs text-error shrink-0">{errorMessage}</div>
        )}

        <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 shrink-0">
          <div className="text-[11px] text-text-muted">
            {selectedPath ? (
              <span className="flex items-center gap-1.5">
                <svg
                  className="h-3 w-3 text-accent"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4.5 12.75l6 6 9-13.5"
                  />
                </svg>
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
              className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover"
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
