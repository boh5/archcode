import { CheckCircle2, XCircle, Circle, RotateCcw, AlertTriangle, Loader2 } from "lucide-react";
import { HitlInbox } from "./HitlCard";
import { useRealtimeHitl } from "../../store/hitl-store";
import type { DoneCondition, DoneResult, GoalState } from "../../api/types";

interface GoalOverviewProps {
  goal: GoalState;
  slug: string;
}

export function GoalOverview({ goal, slug }: GoalOverviewProps) {
  return (
    <div data-testid="goal-overview" className="flex flex-col gap-6 p-5 max-w-3xl mx-auto w-full">
      <GoalMetaSection goal={goal} />
      <DoneConditionsSection goal={goal} />
      <RetryChainSection goal={goal} />
      <ApprovalQueueSection slug={slug} goalId={goal.id} />
    </div>
  );
}

function ApprovalQueueSection({ slug, goalId }: { slug: string; goalId: string }) {
  const hitl = useRealtimeHitl({
    slug,
    scope: "goal",
    ownerId: goalId,
    includeChildren: true,
  });

  return (
    <div data-testid="goal-approval-queue">
      <HitlInbox
        projections={hitl}
        emptyMessage="No pending approvals for this goal"
      />
    </div>
  );
}

function GoalMetaSection({ goal }: { goal: GoalState }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <MetaItem label="Status" value={goal.status} />
        <MetaItem label="Phase" value={goal.phase} />
        <MetaItem label="Reviewer" value={goal.reviewerAgent} />
        <MetaItem label="Author" value={goal.author} />
      </div>
      {goal.lastError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-error-muted border border-error/20 text-[12.5px] text-error">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span className="break-words">{goal.lastError}</span>
        </div>
      )}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-muted uppercase tracking-wider">{label}</span>
      <span className="text-[12.5px] text-text-secondary font-medium">{value}</span>
    </div>
  );
}

function DoneConditionsSection({ goal }: { goal: GoalState }) {
  if (goal.doneConditions.length === 0) {
    return (
      <div>
        <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
          Done Conditions
        </h3>
        <p className="text-sm text-text-tertiary">No done conditions defined</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Done Conditions
      </h3>
      <div className="flex flex-col gap-2">
        {goal.doneConditions.map((condition) => (
          <DoneConditionRow
            key={condition.id}
            condition={condition}
            result={goal.doneResults[condition.id]}
          />
        ))}
      </div>
    </div>
  );
}

function DoneConditionRow({ condition, result }: { condition: DoneCondition; result?: DoneResult }) {
  const passed = result?.passed;
  const hasResult = result !== undefined;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-md bg-bg-elevated border border-border-subtle">
      <div className="flex items-center gap-2">
        {hasResult ? (
          passed ? (
            <CheckCircle2 size={14} className="text-success shrink-0" />
          ) : (
            <XCircle size={14} className="text-error shrink-0" />
          )
        ) : (
          <Circle size={14} className="text-text-muted shrink-0" />
        )}
        <span className="text-[12.5px] font-medium text-text-primary">{condition.kind}</span>
        {condition.required === false && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-active text-text-muted">optional</span>
        )}
        <span className="text-[11px] text-text-muted font-mono ml-auto">{condition.id.slice(0, 8)}</span>
      </div>
      <div className="pl-5.5 flex flex-col gap-1">
        <ConditionParams condition={condition} />
        {result && (
          <div className="text-[11.5px] text-text-tertiary break-words">
            <span className={passed ? "text-success" : "text-error"}>Evidence: </span>
            {result.evidence}
          </div>
        )}
      </div>
    </div>
  );
}

function ConditionParams({ condition }: { condition: DoneCondition }) {
  const params = condition.params as Record<string, unknown>;
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);

  if (entries.length === 0) return null;

  return (
    <div className="text-[11.5px] text-text-muted font-mono break-all">
      {entries.map(([key, value]) => (
        <span key={key} className="mr-3">
          <span className="text-text-tertiary">{key}:</span> {String(value)}
        </span>
      ))}
    </div>
  );
}

function RetryChainSection({ goal }: { goal: GoalState }) {
  const hasRetries = goal.retryCount > 0;
  const hasError = Boolean(goal.lastError);

  if (!hasRetries && !hasError) return null;

  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Retry Chain
      </h3>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-elevated border border-border-subtle">
          <RotateCcw size={14} className="text-warning shrink-0" />
          <span className="text-[12.5px] text-text-secondary">
            Retry {goal.retryCount} / {goal.retryPolicy.maxRetries}
          </span>
          {goal.retryPolicy.escalateOnFailure && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-error-muted text-error ml-auto">
              escalates on exhaustion
            </span>
          )}
        </div>
        {hasError && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-error-muted border border-error/20 text-[12px] text-error">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span className="break-words">{goal.lastError}</span>
          </div>
        )}
      </div>
    </div>
  );
}
