import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAddProject } from "../../api/mutations";

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddProjectModal({ open, onClose }: AddProjectModalProps) {
  const navigate = useNavigate();
  const addProject = useAddProject();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);

  // ─── Reset form on open ───
  useEffect(() => {
    if (open) {
      setPath("");
      setName("");
    }
  }, [open]);

  // ─── Close on Escape ───
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!path.trim()) return;

      addProject.mutate(
        { path: path.trim(), name: name.trim() || undefined },
        {
          onSuccess: (project) => {
            navigate(`/projects/${project.slug}`);
            onClose();
          },
        },
      );
    },
    [path, addProject, navigate, onClose],
  );

  // ─── Click outside to close ───
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  const isPending = addProject.isPending;
  const errorMessage = addProject.error
    ? addProject.error instanceof Error
      ? addProject.error.message
      : "Failed to add project"
    : null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleOverlayClick}
    >
      <div className="w-[min(480px,90vw)] max-h-[80vh] overflow-y-auto rounded-lg border border-border-default bg-bg-surface shadow-lg">
        {/* ─── Header ─── */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">
            Add Project
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ─── Body ─── */}
        <form onSubmit={handleSubmit} className="p-5">
          <div className="mb-4">
            <label
              htmlFor="project-path"
              className="mb-1.5 block text-xs font-medium text-text-secondary"
            >
              Workspace path
            </label>
            <input
              id="project-path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/project"
              autoFocus
              className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2.5 text-[13.5px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              disabled={isPending}
            />
          </div>

          <div className="mb-4">
            <label
              htmlFor="project-name"
              className="mb-1.5 block text-xs font-medium text-text-secondary"
            >
              Name{" "}
              <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2.5 text-[13.5px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              disabled={isPending}
            />
          </div>

          {errorMessage && (
            <p className="mb-4 text-xs text-error">{errorMessage}</p>
          )}
        </form>

        {/* ─── Actions ─── */}
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
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
            disabled={!path.trim() || isPending}
          >
            {isPending ? "Adding..." : "Add Project"}
          </button>
        </div>
      </div>
    </div>
  );
}