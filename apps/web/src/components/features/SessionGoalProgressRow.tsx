import { type ReactNode, useState } from "react";
import type { SessionGoalView } from "../../api/types";
import { useEditSessionGoal, useSessionGoalControl, useSetSessionGoalBudget } from "../../api/mutations";
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from "../ui/Dialog";

export function SessionGoalProgressRow({
  slug,
  sessionId,
  goal,
}: {
  slug: string;
  sessionId: string;
  goal: SessionGoalView | undefined;
}) {
  const editGoal = useEditSessionGoal();
  const controlGoal = useSessionGoalControl();
  const setBudget = useSetSessionGoalBudget();
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudgetValue] = useState("");
  const [removeBudget, setRemoveBudget] = useState(false);

  if (!goal) return null;

  const busy = editGoal.isPending || controlGoal.isPending || setBudget.isPending;
  const controls = sessionGoalControlVisibility(goal.status);
  const rowMutationError = sessionGoalMutationError(controlGoal.error);
  const dialogMutationError = sessionGoalMutationError(editGoal.error, setBudget.error);
  const trimmedObjective = objective.trim();
  const parsedBudget = Number(budget);
  const objectiveChanged = trimmedObjective !== goal.objective;
  const budgetChanged = goal.status === "budget_limited"
    && (removeBudget ? goal.tokenBudget !== undefined : parsedBudget !== goal.tokenBudget);
  const budgetValid = !budgetChanged
    || removeBudget
    || (Number.isSafeInteger(parsedBudget) && parsedBudget > goal.usage.tokens.totalTokens);
  const canSave = trimmedObjective.length > 0 && (objectiveChanged || budgetChanged) && budgetValid && !busy;

  const openEditor = () => {
    editGoal.reset();
    setBudget.reset();
    setObjective(goal.objective);
    setBudgetValue(String(goal.tokenBudget ?? goal.usage.tokens.totalTokens + 10_000));
    setRemoveBudget(false);
    setEditing(true);
  };

  const save = async () => {
    if (!canSave) return;
    try {
      if (objectiveChanged) {
        await editGoal.mutateAsync({
          slug,
          sessionId,
          objective: trimmedObjective,
          expectedGeneration: goal.generation,
        });
      }
      if (budgetChanged) {
        await setBudget.mutateAsync({
          slug,
          sessionId,
          tokenBudget: removeBudget ? null : parsedBudget,
        });
      }
      setEditing(false);
    } catch {
      // Mutation state owns the actionable API error shown in the Dialog.
    }
  };

  return (
    <>
      <section
        className="flex min-h-[34px] min-w-0 shrink-0 items-center gap-2 rounded-[10px] border border-accent/25 bg-accent-subtle px-2 py-1.5"
        data-testid="session-goal-progress-row"
        aria-label="Session goal"
      >
        <span aria-hidden="true" className="shrink-0 text-xs text-accent">◎</span>
        <strong className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-accent">{goalLabel(goal.status)}</strong>
        <span className="shrink-0 rounded-sm bg-bg-base/70 px-1.5 py-px text-[10px] font-medium text-text-secondary max-[560px]:hidden">{goal.status}</span>
        <span
          className="min-w-0 flex-1 truncate text-xs text-text-primary"
          title={goal.blockedReason ? `${goal.objective}\n${goal.blockedReason}` : goal.objective}
        >
          {goal.objective}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[10px] text-text-tertiary max-[700px]:hidden">
          {goal.usage.executionCount} turns · {goal.usage.tokens.totalTokens.toLocaleString()} tokens · {formatDuration(Math.round(goal.usage.executionTimeMs / 1_000))}
        </span>
        {rowMutationError && <span className="max-w-40 truncate text-[10px] text-error" role="alert" title={rowMutationError}>{rowMutationError}</span>}
        <div className="flex shrink-0 items-center gap-1">
          {controls.edit && <ControlButton disabled={busy} onClick={openEditor}>Edit</ControlButton>}
          {controls.pause && <ControlButton disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "pause" })}>Pause</ControlButton>}
          {controls.resume && <ControlButton disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "resume" })}>Resume</ControlButton>}
          {controls.clear && <ControlButton danger disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "clear" })}>Clear</ControlButton>}
        </div>
      </section>

      <DialogRoot open={editing} onOpenChange={(open) => { if (!open && !busy) setEditing(false); }}>
        <DialogContent>
          <div className="p-5">
            <DialogTitle className="text-base font-semibold text-text-primary">Edit goal</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-text-muted">
              Update the objective{goal.status === "budget_limited" ? " and recover from the current token limit" : ""}.
            </DialogDescription>

            <label className="mt-4 grid gap-1.5 text-xs text-text-secondary">
              Objective
              <textarea
                aria-label="Goal objective"
                autoFocus
                className="min-h-28 resize-y rounded-md border border-border-default bg-bg-base px-3 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-accent"
                disabled={busy}
                maxLength={4000}
                onChange={(event) => setObjective(event.target.value)}
                value={objective}
              />
            </label>

            {goal.status === "budget_limited" && (
              <fieldset className="mt-4 grid gap-2" data-testid="goal-budget-editor">
                <legend className="text-xs font-medium text-text-secondary">Token budget</legend>
                <input
                  aria-label="Goal token budget"
                  className="w-full rounded-md border border-border-default bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-50"
                  disabled={busy || removeBudget}
                  min={goal.usage.tokens.totalTokens + 1}
                  onChange={(event) => setBudgetValue(event.target.value)}
                  step={1000}
                  type="number"
                  value={budget}
                />
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    checked={removeBudget}
                    disabled={busy}
                    onChange={(event) => setRemoveBudget(event.target.checked)}
                    type="checkbox"
                  />
                  Remove token limit
                </label>
                {!budgetValid && <p className="text-xs text-error" role="alert">The new budget must be greater than used tokens.</p>}
              </fieldset>
            )}

            {dialogMutationError && <p className="mt-3 text-xs text-error" role="alert">{dialogMutationError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <DialogButton disabled={busy} onClick={() => setEditing(false)}>Cancel</DialogButton>
              <DialogButton primary disabled={!canSave} onClick={() => { void save(); }}>Save</DialogButton>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

function ControlButton({
  children,
  danger = false,
  disabled,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-sm px-1.5 py-1 text-[10px] font-medium text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 ${danger ? "hover:text-error" : "hover:text-text-primary"}`}
    >
      {children}
    </button>
  );
}

function DialogButton({
  children,
  disabled,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${primary
        ? "border-accent bg-accent text-white"
        : "border-border-default bg-bg-base text-text-secondary hover:text-text-primary"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function goalLabel(status: SessionGoalView["status"]): string {
  if (status === "active") return "Pursuing goal";
  if (status === "paused") return "Goal paused";
  if (status === "blocked") return "Goal blocked";
  if (status === "budget_limited") return "Goal budget limited";
  return "Goal complete";
}

export function sessionGoalControlVisibility(status: SessionGoalView["status"]): {
  edit: boolean;
  pause: boolean;
  resume: boolean;
  clear: true;
} {
  return {
    edit: status !== "complete",
    pause: status === "active",
    resume: status === "paused" || status === "blocked",
    clear: true,
  };
}

export function sessionGoalMutationError(...errors: readonly unknown[]): string | undefined {
  const error = errors.find((candidate) => candidate !== null && candidate !== undefined);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : error === undefined
      ? undefined
      : "Unable to update this goal.";
}
