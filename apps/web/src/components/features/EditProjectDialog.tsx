import { useState, useEffect, useCallback } from "react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useUpdateProjectName } from "../../api/mutations";
import type { Project } from "../../api/types";

interface EditProjectDialogProps {
  open: boolean;
  onClose: () => void;
  project: Project;
}

export function EditProjectDialog({
  open,
  onClose,
  project,
}: EditProjectDialogProps) {
  const [name, setName] = useState(project.name);
  const updateName = useUpdateProjectName();

  useEffect(() => {
    if (open) {
      setName(project.name);
    }
  }, [open, project.name]);

  const trimmed = name.trim();
  const isChanged = trimmed !== project.name && trimmed.length > 0;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!isChanged) return;
      updateName.mutate(
        { slug: project.slug, name: trimmed },
        { onSuccess: () => onClose() },
      );
    },
    [isChanged, updateName, project.slug, trimmed, onClose],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  const errorMessage = updateName.error
    ? updateName.error instanceof Error
      ? updateName.error.message
      : "Failed to update project name"
    : null;

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
            <DialogTitle className="text-base font-semibold text-text-primary">
              Edit project
            </DialogTitle>
          </div>

          <DialogDescription className="sr-only">
            Change the display name for {project.name}
          </DialogDescription>

          <div className="px-5 py-4">
            <label
              htmlFor="edit-project-name"
              className="mb-1.5 block text-[13px] font-medium text-text-secondary"
            >
              Name
            </label>
            <input
              id="edit-project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
              autoFocus
              disabled={updateName.isPending}
            />
          </div>

          {errorMessage && (
            <div className="px-5 pb-2 text-xs text-error">{errorMessage}</div>
          )}

          <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover"
              disabled={updateName.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!isChanged || updateName.isPending}
            >
              {updateName.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}