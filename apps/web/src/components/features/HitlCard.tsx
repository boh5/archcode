import { useState, useCallback } from "react";
import { ShieldCheck, ShieldX, CircleQuestionMark, FileSearch, X, Check, Loader2 } from "lucide-react";
import { useRespondHitl, useCancelHitl } from "../../api/mutations";
import type { DashboardHitlItem } from "../../api/types";

const KIND_BORDER: Record<string, string> = {
  approval: "border-warning",
  question: "border-info",
  review: "border-accent",
};

const KIND_ICON: Record<string, typeof ShieldCheck> = {
  approval: ShieldCheck,
  question: CircleQuestionMark,
  review: FileSearch,
};

const KIND_LABEL: Record<string, string> = {
  approval: "Approval",
  question: "Question",
  review: "Review",
};

const TRIGGER_LABEL: Record<string, string> = {
  approval_point: "Approval Point",
  tool_approval: "Tool Approval",
  agent_request: "Agent Request",
};

function formatTriggerSource(source?: string): string | undefined {
  if (!source) return undefined;
  if (source.startsWith("goal.approval.")) return source.slice("goal.approval.".length);
  if (source === "goal.review") return "review";
  return source;
}

export function HitlCard({ item }: { item: DashboardHitlItem }) {
  const respond = useRespondHitl();
  const cancel = useCancelHitl();
  const [comment, setComment] = useState("");

  const kind = item.kind;
  const display = item.displayPayload;
  const Icon = KIND_ICON[kind] ?? CircleQuestionMark;
  const borderClass = KIND_BORDER[kind] ?? "border-border-default";

  const respondPending = respond.isPending;
  const cancelPending = cancel.isPending;
  const anyPending = respondPending || cancelPending;

  const handleApprove = useCallback(() => {
    if (respondPending) return;
    if (kind === "approval") {
      respond.mutate({ projectSlug: item.projectSlug, hitlId: item.hitlId, body: { decision: "approved", comment: comment || undefined } });
    } else if (kind === "review") {
      respond.mutate({ projectSlug: item.projectSlug, hitlId: item.hitlId, body: { outcome: "DONE", comment: comment || undefined } });
    } else if (kind === "question") {
      respond.mutate({ projectSlug: item.projectSlug, hitlId: item.hitlId, body: { answers: [], comment: comment || undefined } });
    }
  }, [kind, respond, respondPending, item.projectSlug, item.hitlId, comment]);

  const handleDeny = useCallback(() => {
    if (respondPending) return;
    if (kind === "approval") {
      respond.mutate({ projectSlug: item.projectSlug, hitlId: item.hitlId, body: { decision: "denied", comment: comment || undefined } });
    } else if (kind === "review") {
      respond.mutate({ projectSlug: item.projectSlug, hitlId: item.hitlId, body: { outcome: "NOT_DONE", comment: comment || undefined } });
    }
  }, [kind, respond, respondPending, item.projectSlug, item.hitlId, comment]);

  const handleCancel = useCallback(() => {
    if (cancelPending) return;
    cancel.mutate({ projectSlug: item.projectSlug, hitlId: item.hitlId });
  }, [cancel, cancelPending, item.projectSlug, item.hitlId]);

  const triggerLabel = formatTriggerSource(item.trigger.source) ?? item.trigger.approvalPoint;

  return (
    <div
      data-testid="hitl-card"
      className={`bg-bg-elevated border-[1.5px] ${borderClass} rounded-md px-3.5 py-2.5 shrink-0`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm shrink-0" aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="font-semibold text-[13px] text-text-primary">{KIND_LABEL[kind] ?? kind}</span>
        <span className="text-[11px] text-text-muted">— {item.projectName}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-1.5 text-[10.5px] text-text-tertiary">
        {item.trigger.goalId && (
          <span className="font-mono" data-testid="hitl-context-goal">goal: {item.trigger.goalId}</span>
        )}
        <span className="font-mono" data-testid="hitl-context-session">session: {item.sessionId}</span>
        {triggerLabel && (
          <span data-testid="hitl-context-trigger">{TRIGGER_LABEL[item.trigger.source?.startsWith("goal.") ? "approval_point" : "agent_request"] ?? "Trigger"}: {triggerLabel}</span>
        )}
      </div>

      <div className="text-[12.5px] text-text-primary leading-[1.55] mb-1.5" data-testid="hitl-display-title">
        {display.title}
      </div>

      {display.summary && (
        <div className="text-[12px] text-text-secondary leading-[1.5] mb-2" data-testid="hitl-display-summary">
          {display.summary}
        </div>
      )}

      {display.fields && display.fields.length > 0 && (
        <div className="flex flex-col gap-0.5 mb-2 max-h-[100px] overflow-y-auto" data-testid="hitl-display-fields">
          {display.fields.map((field, idx) => (
            <div key={`${field.label}-${idx}`} className="font-mono text-[11px] text-text-muted py-0.5 border-b border-border-subtle last:border-b-0">
              <span className="text-text-tertiary">{field.label}:</span> <span className="text-text-secondary">{field.value}</span>
            </div>
          ))}
        </div>
      )}

      <input
        type="text"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Add a comment (optional)…"
        disabled={anyPending}
        className="w-full bg-bg-base border border-border-default rounded-sm px-2.5 py-1.5 text-[12px] text-text-primary font-sans outline-none transition-colors duration-150 focus:border-accent placeholder:text-text-muted mb-2 disabled:opacity-50 disabled:cursor-not-allowed"
      />

      <div className="flex flex-wrap gap-1.5">
        {kind === "approval" && (
          <>
            <button
              data-testid="hitl-approve-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleApprove}
              disabled={anyPending}
            >
              {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Done
            </button>
            <button
              data-testid="hitl-deny-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-error-muted text-error cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleDeny}
              disabled={anyPending}
            >
              <ShieldX size={12} /> Deny
            </button>
          </>
        )}

        {kind === "review" && (
          <>
            <button
              data-testid="hitl-approve-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleApprove}
              disabled={anyPending}
            >
              {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} DONE
            </button>
            <button
              data-testid="hitl-deny-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-error-muted text-error cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleDeny}
              disabled={anyPending}
            >
              <X size={12} /> NOT DONE
            </button>
          </>
        )}

        {kind === "question" && (
          <button
            data-testid="hitl-approve-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-accent text-white cursor-pointer transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            onClick={handleApprove}
            disabled={anyPending}
          >
            {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Submit Answer
          </button>
        )}

        <button
          data-testid="hitl-cancel-button"
          className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-bg-active text-text-muted cursor-pointer transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleCancel}
          disabled={anyPending}
        >
          {cancelPending ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Cancel
        </button>
      </div>
    </div>
  );
}