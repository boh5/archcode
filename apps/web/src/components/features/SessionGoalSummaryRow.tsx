import { type ReactNode, useId, useState } from "react";
import { Clock3, Cpu, Pause, Pencil, Play, Trash2, Workflow } from "lucide-react";
import type { SessionGoalView } from "../../api/types";
import { useEditSessionGoal, useSessionGoalControl, useSetSessionGoalBudget } from "../../api/mutations";
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from "../ui/Dialog";
import { IconAction } from "../primitives/IconAction";
import { GoalStatusMark } from "./GoalStatusMark";
import { presentSessionGoalStatus } from "../../lib/session-goal-presentation";
import { STATUS_TONE_CLASS } from "../../lib/status-visuals";

export function SessionGoalSummaryRow({
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
  const blockedReasonId = useId();

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
  const goalPresentation = presentSessionGoalStatus(goal.status);

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
        className="flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle bg-transparent px-1 py-2"
        data-testid="session-goal-summary-row"
        aria-label="Session goal"
      >
        <GoalStatusMark identity={goal.instanceId} status={goal.status} size={16} label={`Goal ${goalPresentation.label}`} />
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted max-[559px]:hidden">Goal</span>
        <strong className={`shrink-0 text-[11px] font-semibold max-[559px]:hidden ${STATUS_TONE_CLASS[goalPresentation.tone]}`}>{goalPresentation.label}</strong>
        <span
          aria-describedby={goal.blockedReason ? blockedReasonId : undefined}
          className="min-w-[48px] flex-1 truncate text-[12px] font-medium leading-5 text-text-primary min-[560px]:min-w-24 min-[800px]:min-w-[120px]"
          title={goal.blockedReason ? `${goal.objective}\n${goal.blockedReason}` : goal.objective}
        >
          {goal.objective}
        </span>
        {goal.blockedReason && <span id={blockedReasonId} className="sr-only">{goal.blockedReason}</span>}
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap font-mono text-[9px] tabular-nums text-text-tertiary max-[799px]:hidden">
          <span className="inline-flex items-center gap-1" title={`${goal.usage.executionCount} executions`}><Workflow size={12} aria-hidden="true" />{goal.usage.executionCount}<span className="max-[1099px]:hidden"> executions</span></span>
          <span className="inline-flex items-center gap-1" title={`${goal.usage.tokens.totalTokens.toLocaleString()} tokens`}><Cpu size={12} aria-hidden="true" />{goal.usage.tokens.totalTokens.toLocaleString()}<span className="max-[1099px]:hidden"> tokens</span></span>
          <span className="inline-flex items-center gap-1" title={`${Math.round(goal.usage.executionTimeMs / 1_000)} seconds`}><Clock3 size={12} aria-hidden="true" />{formatDuration(Math.round(goal.usage.executionTimeMs / 1_000))}</span>
        </span>
        {rowMutationError && <span className="max-w-40 truncate text-[11px] text-error" role="alert" title={rowMutationError}>{rowMutationError}</span>}
        <div className="flex shrink-0 items-center gap-1">
          {controls.edit && <IconAction label="Edit goal" disabled={busy} onClick={openEditor}><Pencil size={14} aria-hidden="true" /></IconAction>}
          {controls.pause && <IconAction label="Pause goal" disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "pause" })}><Pause size={14} aria-hidden="true" /></IconAction>}
          {controls.resume && <IconAction label="Resume goal" disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "resume" })}><Play size={14} aria-hidden="true" /></IconAction>}
          {controls.clear && <IconAction danger label="Clear goal" disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "clear" })}><Trash2 size={14} aria-hidden="true" /></IconAction>}
        </div>
      </section>

      <DialogRoot open={editing} onOpenChange={(open) => { if (!open && !busy) setEditing(false); }}>
        <DialogContent>
          <div className="p-5">
            <DialogTitle className="text-base font-semibold text-text-primary">Edit goal</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-text-tertiary">
              Update the objective{goal.status === "budget_limited" ? " and recover from the current token limit" : ""}.
            </DialogDescription>

            <label className="mt-4 grid gap-2 text-xs text-text-secondary">
              Objective
              <textarea
                aria-label="Goal objective"
                autoFocus
                className="min-h-28 resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 text-[13px] leading-5 text-text-primary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle"
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
                  className="h-8 w-full rounded-sm border border-border-control bg-bg-base px-3 text-[12px] leading-4 text-text-primary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle disabled:opacity-50"
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
      className={`h-8 rounded-sm border px-3 text-[12px] font-medium leading-4 transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 ${primary
        ? "border-brand bg-brand text-bg-overlay"
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
