import { useCallback } from "react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useDeleteProject } from "../../api/mutations";
import type { Project } from "../../api/types";

interface CloseProjectDialogProps {
  open: boolean;
  onClose: () => void;
  project: Project;
  onClosed?: (project: Project) => void;
}

export function CloseProjectDialog({
  open,
  onClose,
  project,
  onClosed,
}: CloseProjectDialogProps) {
  const deleteProject = useDeleteProject();

  const handleConfirm = useCallback(() => {
    deleteProject.mutate(project.slug, {
      onSuccess: () => {
        onClosed?.(project);
        onClose();
      },
    });
  }, [deleteProject, project, onClosed, onClose]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  const errorMessage = deleteProject.error
    ? deleteProject.error instanceof Error
      ? deleteProject.error.message
      : "Failed to close project"
    : null;

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <DialogTitle className="text-base font-semibold text-text-primary">
            Close project
          </DialogTitle>
        </div>

        <DialogDescription className="sr-only">
          Remove {project.name} from the project list
        </DialogDescription>

        <div className="px-5 py-4">
          <p className="text-[13px] text-text-secondary leading-relaxed">
            Are you sure you want to close{" "}
            <span className="font-semibold text-text-primary">
              {project.name}
            </span>
            ?
          </p>
          <p className="mt-1.5 font-mono text-[12px] text-text-muted truncate">
            {project.workspaceRoot}
          </p>
          <p className="mt-3 text-[12px] text-text-muted leading-relaxed">
            The workspace folder will <strong>not</strong> be deleted. This only
            removes the project from the sidebar.
          </p>
        </div>

        {errorMessage && (
          <div className="px-5 pb-2 text-xs text-error">{errorMessage}</div>
        )}

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover"
            disabled={deleteProject.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded-sm bg-error px-4 py-2 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={deleteProject.isPending}
          >
            {deleteProject.isPending ? "Closing…" : "Close Project"}
          </button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}