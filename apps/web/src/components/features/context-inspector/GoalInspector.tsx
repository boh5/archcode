import { ExternalLink, FileText, GitBranch } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useGoal } from "../../../api/queries";
import type { GoalEvidenceRef, GoalState } from "../../../api/types";
import { InspectorNotice, InspectorParagraph, InspectorRows, InspectorSection } from "./InspectorPrimitives";

export type GoalInspectorTab = "overview" | "evidence" | "sessions";

export function GoalInspector({ activeTab }: { activeTab: GoalInspectorTab }) {
  const { slug = "", goalId = "" } = useParams<{ slug: string; goalId: string }>();
  const { data: goal, isLoading } = useGoal(slug, goalId);
  if (isLoading) return <InspectorNotice>Loading goal…</InspectorNotice>;
  if (!goal) return <InspectorNotice>Goal context unavailable</InspectorNotice>;

  if (activeTab === "overview") {
    return (
      <div className="space-y-4">
        <InspectorSection title="Acceptance criteria"><InspectorParagraph>{goal.acceptanceCriteria}</InspectorParagraph></InspectorSection>
        <InspectorSection title="Objective"><InspectorParagraph>{goal.objective}</InspectorParagraph></InspectorSection>
        <InspectorRows rows={[
          ["Status", goal.status],
          ["Attempt", String(goal.attempt)],
          ["Worktree", formatGoalWorktreeStatus(goal)],
          ["Budget", goal.budget?.status ?? "not set"],
          ...(goal.budget?.usedTokens !== undefined ? [["Tokens used", goal.budget.usedTokens.toLocaleString()] as [string, string]] : []),
          ...(goal.budget?.maxTokens !== undefined ? [["Token limit", goal.budget.maxTokens.toLocaleString()] as [string, string]] : []),
        ]} />
        {goal.budget?.reason && <InspectorSection title="Budget reason"><InspectorParagraph>{goal.budget.reason}</InspectorParagraph></InspectorSection>}
        {goal.worktree && (
          <InspectorSection title="Worktree">
            <InspectorRows rows={[
              ["Branch", goal.worktree.branchName],
              ["Path", goal.worktree.path],
              ["Base", goal.worktree.baseSha],
              ["Created", goal.worktree.createdAt],
            ]} />
          </InspectorSection>
        )}
        {goal.blocker && (
          <InspectorSection title="Blocker">
            <InspectorRows rows={[
              ["Kind", goal.blocker.kind],
              ["Resume status", goal.blocker.resumeStatus],
            ]} />
            <InspectorNotice tone="warning">{goal.blocker.summary}</InspectorNotice>
          </InspectorSection>
        )}
      </div>
    );
  }

  if (activeTab === "evidence") {
    const evidence = goal.review?.evidenceRefs ?? [];
    return (
      <div className="space-y-3">
        {goal.review && (
          <InspectorSection title={`Reviewer · ${goal.review.verdict}`}>
            <InspectorParagraph>{goal.review.summary}</InspectorParagraph>
            <InspectorRows rows={[["Decided", new Date(goal.review.decidedAt).toLocaleString()]]} />
          </InspectorSection>
        )}
        {goal.finalSummary && <InspectorSection title="Final summary"><InspectorParagraph>{goal.finalSummary}</InspectorParagraph></InspectorSection>}
        {evidence.length === 0 ? <InspectorNotice>No reviewer evidence recorded</InspectorNotice> : evidence.map((item, index) => (
          <EvidenceItem key={`${item.kind}-${item.ref}-${index}`} item={item} slug={slug} />
        ))}
        {goal.review?.unresolvedItems?.map((item) => <InspectorNotice key={item} tone="warning">{item}</InspectorNotice>)}
      </div>
    );
  }

  if (activeTab === "sessions") {
    const sessionIds = Array.from(new Set(
      [goal.mainSessionId, ...goal.childSessionIds, goal.review?.reviewerSessionId]
        .filter((id): id is string => Boolean(id)),
    ));
    if (sessionIds.length === 0) return <InspectorNotice>No goal sessions yet</InspectorNotice>;
    return (
      <div className="space-y-1">
        {sessionIds.map((id) => (
          <Link key={id} className="flex items-center gap-2 rounded-sm px-2 py-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary" to={`/projects/${slug}/sessions/${id}`}>
            <GitBranch size={13} className="text-text-muted" />
            <span className="min-w-0 flex-1 truncate font-mono">{id}</span>
            {id === goal.mainSessionId && <span className="text-[10px] text-accent">main</span>}
            {id === goal.review?.reviewerSessionId && <span className="text-[10px] text-info">reviewer</span>}
          </Link>
        ))}
      </div>
    );
  }

  return assertNever(activeTab);
}

export function formatGoalWorktreeStatus(goal: Pick<GoalState, "useWorktree" | "worktree">): "active" | "pending" | "disabled" {
  if (!goal.useWorktree) return "disabled";
  return goal.worktree ? "active" : "pending";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Goal inspector tab: ${String(value)}`);
}

function EvidenceItem({ item, slug }: { item: GoalEvidenceRef; slug: string }) {
  return (
    <article className="rounded-sm border border-border-subtle bg-bg-base p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        <FileText size={11} aria-hidden="true" />
        {item.kind}
      </div>
      <div className="text-xs leading-5 text-text-secondary">{item.summary}</div>
      <div className="mt-1 break-all font-mono text-[10px] text-text-muted">{item.ref}</div>
      <dl className="mt-2 space-y-1 border-t border-border-subtle pt-2 text-[10px]">
        {item.path && <EvidenceField label="Path" value={item.path} />}
        {item.messageId && <EvidenceField label="Message" value={item.messageId} />}
        {item.toolCallId && <EvidenceField label="Tool call" value={item.toolCallId} />}
        {item.createdAt && <EvidenceField label="Recorded" value={item.createdAt} />}
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.sessionId && (
          <Link className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline" to={`/projects/${slug}/sessions/${item.sessionId}`}>
            <GitBranch size={11} aria-hidden="true" /> Open session
          </Link>
        )}
        {item.url && (
          <a className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline" href={item.url} target="_blank" rel="noreferrer">
            <ExternalLink size={11} aria-hidden="true" /> Open source
          </a>
        )}
      </div>
    </article>
  );
}

function EvidenceField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="break-all font-mono text-text-secondary">{value}</dd>
    </div>
  );
}
