import { useState, useCallback, useEffect } from "react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useCreateGoal } from "../../api/mutations";

interface CreateGoalDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  onCreated: (goalId: string) => void;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function CreateGoalDialog({ open, onClose, slug, onCreated }: CreateGoalDialogProps) {
  const createGoal = useCreateGoal();

  const [objective, setObjective] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");

  useEffect(() => {
    if (open) {
      setObjective("");
      setAcceptanceCriteria("");
    }
  }, [open]);

  const trimmedObjective = objective.trim();
  const trimmedAcceptanceCriteria = acceptanceCriteria.trim();
  const canSubmit =
    isNonEmpty(trimmedObjective) &&
    isNonEmpty(trimmedAcceptanceCriteria) &&
    !createGoal.isPending;

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (!canSubmit) return;

      createGoal.mutate(
        {
          slug,
          objective: trimmedObjective,
          acceptanceCriteria: trimmedAcceptanceCriteria,
        },
        {
          onSuccess: (goal) => {
            onCreated(goal.id);
          },
        },
      );
    },
    [
      canSubmit,
      createGoal,
      slug,
      trimmedObjective,
      trimmedAcceptanceCriteria,
      onCreated,
    ],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  const errorMessage = createGoal.error
    ? createGoal.error instanceof Error
      ? createGoal.error.message
      : "Failed to create goal"
    : null;

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="x-large">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 shrink-0">
            <DialogTitle className="text-base font-semibold text-text-primary">
              New Goal
            </DialogTitle>
            <DialogDescription className="sr-only">
              Create a goal with objective and acceptance criteria. The title is generated asynchronously.
            </DialogDescription>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <div>
              <label
                htmlFor="new-goal-objective"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Objective
              </label>
              <textarea
                id="new-goal-objective"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Describe the task objective in natural language."
                rows={4}
                autoFocus
                disabled={createGoal.isPending}
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150 resize-y"
              />
            </div>

            <div>
              <label
                htmlFor="new-goal-acceptance-criteria"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Acceptance Criteria
              </label>
              <textarea
                id="new-goal-acceptance-criteria"
                value={acceptanceCriteria}
                onChange={(e) => setAcceptanceCriteria(e.target.value)}
                placeholder="Describe what done looks like in natural language. The Reviewer will judge completion against this."
                rows={4}
                disabled={createGoal.isPending}
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150 resize-y"
              />
            </div>
          </div>

          {errorMessage && (
            <div className="px-5 py-2 text-xs text-error shrink-0">{errorMessage}</div>
          )}

          <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover"
              disabled={createGoal.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canSubmit}
            >
              {createGoal.isPending ? "Creating…" : "Create Draft"}
            </button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
