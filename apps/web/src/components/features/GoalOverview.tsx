import { AlertTriangle, CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { HitlInbox } from "./HitlCard";
import { useRealtimeHitl } from "../../store/hitl-store";
import type { GoalEvidenceRef, GoalState } from "../../api/types";

interface GoalOverviewProps {
  goal: GoalState;
  slug: string;
}

export function GoalOverview({ goal, slug }: GoalOverviewProps) {
  return (
    <div data-testid="goal-overview" className="flex flex-col gap-6 p-5 max-w-3xl mx-auto w-full">
      <GoalMetaSection goal={goal} />
      <ObjectiveSection goal={goal} />
      <AcceptanceCriteriaSection goal={goal} />
      <BlockerSection goal={goal} />
      <BudgetSection goal={goal} />
      <ReviewReceiptSection goal={goal} />
      <FinalSummarySection goal={goal} />
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
        <MetaItem label="Attempt" value={String(goal.attempt)} />
      </div>
      {goal.lastError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-error-muted border border-error/20 text-[12.5px] text-error">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span className="break-words">{goal.lastError.name}: {goal.lastError.message}</span>
        </div>
      )}
      {goal.lastFailureSummary && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-warning-muted border border-warning/20 text-[12.5px] text-warning">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span className="break-words">{goal.lastFailureSummary}</span>
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

function ObjectiveSection({ goal }: { goal: GoalState }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Objective
      </h3>
      <p className="text-[13px] text-text-primary whitespace-pre-wrap break-words">{goal.objective}</p>
    </div>
  );
}

function AcceptanceCriteriaSection({ goal }: { goal: GoalState }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Acceptance Criteria
      </h3>
      <p className="text-[13px] text-text-primary whitespace-pre-wrap break-words">{goal.acceptanceCriteria}</p>
    </div>
  );
}

function BlockerSection({ goal }: { goal: GoalState }) {
  if (!goal.blocker) return null;

  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Blocker
      </h3>
      <div className="flex flex-col gap-1 px-3 py-2.5 rounded-md bg-bg-elevated border border-border-subtle">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-warning shrink-0" />
          <span className="text-[12.5px] font-medium text-text-primary">{goal.blocker.kind}</span>
          {goal.blocker.resumeStatus && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-active text-text-muted">
              resumes to {goal.blocker.resumeStatus}
            </span>
          )}
        </div>
        <p className="text-[11.5px] text-text-tertiary break-words">{goal.blocker.summary}</p>
      </div>
    </div>
  );
}

function BudgetSection({ goal }: { goal: GoalState }) {
  if (!goal.budget) return null;

  const statusColor =
    goal.budget.status === "ok"
      ? "text-success"
      : goal.budget.status === "warning"
        ? "text-warning"
        : "text-error";

  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Budget
      </h3>
      <div className="flex flex-col gap-1 px-3 py-2.5 rounded-md bg-bg-elevated border border-border-subtle">
        <div className="flex items-center gap-2">
          <span className={`text-[12.5px] font-medium ${statusColor}`}>{goal.budget.status}</span>
          {goal.budget.usedTokens !== undefined && goal.budget.maxTokens !== undefined && (
            <span className="text-[11px] text-text-muted font-mono">
              {goal.budget.usedTokens.toLocaleString()} / {goal.budget.maxTokens.toLocaleString()} tokens
            </span>
          )}
        </div>
        {goal.budget.reason && (
          <p className="text-[11.5px] text-text-tertiary break-words">{goal.budget.reason}</p>
        )}
      </div>
    </div>
  );
}

function ReviewReceiptSection({ goal }: { goal: GoalState }) {
  if (!goal.review) return null;

  const verdict = goal.review.verdict;
  const isDone = verdict === "DONE";

  return (
    <div data-testid="goal-review-receipt">
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Review Receipt
      </h3>
      <div className="flex flex-col gap-2 px-3 py-2.5 rounded-md bg-bg-elevated border border-border-subtle">
        <div className="flex items-center gap-2">
          {isDone ? (
            <CheckCircle2 size={14} className="text-success shrink-0" />
          ) : (
            <XCircle size={14} className="text-error shrink-0" />
          )}
          <span className={`text-[12.5px] font-medium ${isDone ? "text-success" : "text-error"}`}>
            {verdict}
          </span>
          <span className="text-[11px] text-text-muted ml-auto">
            decided {new Date(goal.review.decidedAt).toLocaleString()}
          </span>
        </div>
        <p className="text-[12px] text-text-secondary whitespace-pre-wrap break-words">{goal.review.summary}</p>

        {goal.review.evidenceRefs.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-1">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">Evidence Refs</span>
            <ul className="flex flex-col gap-1">
              {goal.review.evidenceRefs.map((ref, index) => (
                <EvidenceRefRow key={`${ref.kind}-${ref.ref}-${index}`} ref={ref} projectId={goal.projectId} />
              ))}
            </ul>
          </div>
        )}

        {goal.review.unresolvedItems && goal.review.unresolvedItems.length > 0 && (
          <div className="flex flex-col gap-1 mt-1">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">Unresolved Items</span>
            <ul className="flex flex-col gap-0.5">
              {goal.review.unresolvedItems.map((item, index) => (
                <li key={index} className="text-[11.5px] text-warning break-words">{item}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-[11px] text-text-muted mt-1">
          Reviewer session: <span className="font-mono">{goal.review.reviewerSessionId}</span>
        </div>
      </div>
    </div>
  );
}

function EvidenceRefRow({ ref, projectId }: { ref: GoalEvidenceRef; projectId: string }) {
  const sessionLink = ref.sessionId ? `/projects/${projectId}/sessions/${ref.sessionId}` : null;

  return (
    <li data-testid="goal-evidence-ref" className="flex flex-col gap-0.5 px-2 py-1.5 rounded-sm bg-bg-base border border-border-subtle">
      <div className="flex items-center gap-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-active text-text-muted font-mono">{ref.kind}</span>
        <span className="text-[11.5px] text-text-secondary break-words flex-1">{ref.summary}</span>
        {sessionLink && (
          <Link
            to={sessionLink}
            className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:text-accent-hover shrink-0"
          >
            session <ExternalLink size={10} />
          </Link>
        )}
        {ref.url && (
          <a
            href={ref.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:text-accent-hover shrink-0"
          >
            url <ExternalLink size={10} />
          </a>
        )}
      </div>
      <div className="text-[10.5px] text-text-muted font-mono break-all">
        {ref.toolCallId && <span>toolCall: {ref.toolCallId} </span>}
        {ref.messageId && <span>message: {ref.messageId} </span>}
        {ref.path && <span>path: {ref.path} </span>}
        {ref.ref && <span>ref: {ref.ref}</span>}
      </div>
    </li>
  );
}

function FinalSummarySection({ goal }: { goal: GoalState }) {
  if (!goal.finalSummary) return null;

  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
        Final Summary
      </h3>
      <p className="text-[13px] text-text-primary whitespace-pre-wrap break-words">{goal.finalSummary}</p>
    </div>
  );
}