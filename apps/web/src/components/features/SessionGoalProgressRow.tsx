import { type ReactNode, useState } from "react";
import type { SessionGoalView } from "../../api/types";
import { useEditSessionGoal, useSessionGoalControl, useSetSessionGoalBudget } from "../../api/mutations";

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
  const [editingBudget, setEditingBudget] = useState(false);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [budget, setBudgetValue] = useState(String(Math.max(
    goal?.tokenBudget ?? 0,
    (goal?.usage.tokens.totalTokens ?? 0) + 10_000,
  )));

  if (!goal) return null;

  const busy = editGoal.isPending || controlGoal.isPending || setBudget.isPending;
  const controls = sessionGoalControlVisibility(goal.status);
  const mutationError = sessionGoalMutationError(editGoal.error, controlGoal.error, setBudget.error);
  const save = () => {
    const next = objective.trim();
    if (!next || next === goal.objective) {
      setEditing(false);
      return;
    }
    editGoal.mutate({ slug, sessionId, objective: next, expectedGeneration: goal.generation }, { onSuccess: () => setEditing(false) });
  };

  return (
    <section
      className="rounded-[14px] border border-accent/25 bg-accent-subtle px-3 py-2.5"
      data-testid="session-goal-progress-row"
      aria-label="Session goal"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-text-tertiary">
            <span className="font-semibold uppercase tracking-wide text-accent">{goalLabel(goal.status)}</span>
            <span className="rounded-sm bg-bg-base/70 px-1.5 py-px font-medium text-text-secondary">{goal.status}</span>
            <span>{goal.usage.executionCount} turns</span>
            <span>{goal.usage.tokens.totalTokens.toLocaleString()} tokens</span>
            <span>{formatDuration(Math.round(goal.usage.executionTimeMs / 1_000))}</span>
          </div>
          {editing ? (
            <textarea
              aria-label="Goal objective"
              value={objective}
              disabled={busy}
              onChange={(event) => setObjective(event.target.value)}
              rows={3}
              maxLength={4000}
              className="w-full resize-y rounded-md border border-border-default bg-bg-base px-2 py-1.5 text-xs leading-5 text-text-primary outline-none focus:border-accent"
            />
          ) : (
            <p className="whitespace-pre-wrap break-words text-xs leading-5 text-text-primary">{goal.objective}</p>
          )}
          {editingBudget && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <label className="text-[11px] text-text-secondary" htmlFor={`goal-budget-${sessionId}`}>Token budget</label>
              <input
                id={`goal-budget-${sessionId}`}
                aria-label="Goal token budget"
                type="number"
                min={goal.usage.tokens.totalTokens + 1}
                step={1000}
                value={budget}
                disabled={busy}
                onChange={(event) => setBudgetValue(event.target.value)}
                className="w-32 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[11px] text-text-primary"
              />
              <ControlButton disabled={busy || !Number.isSafeInteger(Number(budget)) || Number(budget) <= goal.usage.tokens.totalTokens} onClick={() => {
                setBudget.mutate({ slug, sessionId, tokenBudget: Number(budget) }, { onSuccess: () => setEditingBudget(false) });
              }}>Apply</ControlButton>
              <ControlButton disabled={busy} onClick={() => {
                setBudget.mutate({ slug, sessionId, tokenBudget: null }, { onSuccess: () => setEditingBudget(false) });
              }}>Remove limit</ControlButton>
              <ControlButton disabled={busy} onClick={() => setEditingBudget(false)}>Cancel</ControlButton>
            </div>
          )}
          {latestReason(goal) && <p className="mt-1.5 break-words text-[11px] leading-4 text-text-secondary">{latestReason(goal)}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {editing ? (
            <>
              <ControlButton disabled={busy} onClick={save}>Save</ControlButton>
              <ControlButton disabled={busy} onClick={() => { setObjective(goal.objective); setEditing(false); }}>Cancel</ControlButton>
            </>
          ) : (
            <>
              {controls.edit && <ControlButton disabled={busy} onClick={() => { setObjective(goal.objective); setEditing(true); }}>Edit</ControlButton>}
              {controls.pause && <ControlButton disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "pause" })}>Pause</ControlButton>}
              {controls.resume && (
                <ControlButton disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "resume" })}>Resume</ControlButton>
              )}
              {controls.adjustBudget && (
                <ControlButton disabled={busy} onClick={() => {
                  setBudgetValue(String(Math.max(goal.tokenBudget ?? 0, goal.usage.tokens.totalTokens + 10_000)));
                  setEditingBudget(true);
                }}>Adjust budget</ControlButton>
              )}
              {controls.clear && <ControlButton disabled={busy} onClick={() => controlGoal.mutate({ slug, sessionId, action: "clear" })}>Clear</ControlButton>}
            </>
          )}
        </div>
      </div>
      {mutationError && <p className="mt-1.5 text-[11px] text-error">{mutationError}</p>}
    </section>
  );
}

function ControlButton({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[11px] font-medium text-text-secondary hover:border-accent hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
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

function latestReason(goal: SessionGoalView): string | undefined {
  return goal.blockedReason;
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
  adjustBudget: boolean;
  clear: true;
} {
  return {
    edit: status !== "complete",
    pause: status === "active",
    resume: status === "paused" || status === "blocked",
    adjustBudget: status === "budget_limited",
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
