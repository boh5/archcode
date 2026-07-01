import { useState, useCallback } from "react";
import { ShieldCheck, ShieldX, CircleQuestionMark, FileSearch, X, Check, RotateCcw } from "lucide-react";
import { useRespondHitl, useCancelHitl } from "../../api/mutations";
import type { DashboardHitlItem, DashboardHitlPayload } from "../../api/types";

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

function payloadPrompt(payload: DashboardHitlPayload): { title?: string; message?: string } {
  if (payload.title || payload.message) {
    return { title: payload.title, message: payload.message };
  }
  if (payload.kind === "approval") {
    return { title: payload.action, message: undefined };
  }
  if (payload.kind === "review") {
    return { title: "Review artifacts", message: undefined };
  }
  if (payload.kind === "question") {
    return { title: undefined, message: undefined };
  }
  return { title: undefined, message: undefined };
}

export function HitlCard({ item }: { item: DashboardHitlItem }) {
  const respond = useRespondHitl();
  const cancel = useCancelHitl();
  const [comment, setComment] = useState("");
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);

  const payload = item.payload;
  const kind = item.kind;
  const Icon = KIND_ICON[kind] ?? CircleQuestionMark;
  const borderClass = KIND_BORDER[kind] ?? "border-border-default";
  const { title, message } = payloadPrompt(payload);
  const displayTitle = title ?? message ?? item.payload.title ?? "Action required";

  const handleApprove = useCallback(() => {
    if (kind === "approval") {
      respond.mutate({ hitlId: item.hitlId, body: { decision: "approve", comment: comment || undefined } });
    } else if (kind === "review") {
      respond.mutate({ hitlId: item.hitlId, body: { verdict: "approve", comment: comment || undefined } });
    } else if (kind === "question") {
      respond.mutate({ hitlId: item.hitlId, body: { answers: selectedAnswer ? [selectedAnswer] : [], comment: comment || undefined } });
    }
  }, [kind, respond, item.hitlId, comment, selectedAnswer]);

  const handleDeny = useCallback(() => {
    if (kind === "approval") {
      respond.mutate({ hitlId: item.hitlId, body: { decision: "deny", comment: comment || undefined } });
    } else if (kind === "review") {
      respond.mutate({ hitlId: item.hitlId, body: { verdict: "reject", comment: comment || undefined } });
    }
  }, [kind, respond, item.hitlId, comment]);

  const handleRequestChanges = useCallback(() => {
    respond.mutate({ hitlId: item.hitlId, body: { verdict: "request_changes", comment: comment || undefined } });
  }, [respond, item.hitlId, comment]);

  const handleCancel = useCallback(() => {
    cancel.mutate({ hitlId: item.hitlId });
  }, [cancel, item.hitlId]);

  const handleAnswerSelect = useCallback((label: string) => {
    setSelectedAnswer((prev) => (prev === label ? null : label));
  }, []);

  const questionOptions = kind === "question" && payload.kind === "question"
    ? payload.options ?? []
    : [];
  const reviewArtifacts = kind === "review" && payload.kind === "review"
    ? payload.artifacts
    : [];

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
        {item.trigger.goalId && (
          <span className="text-[11px] text-text-muted font-mono">{item.trigger.goalId}</span>
        )}
      </div>

      <div className="text-[12.5px] text-text-primary leading-[1.55] mb-1.5">
        {displayTitle}
      </div>

      {message && displayTitle !== message && (
        <div className="text-[12px] text-text-secondary leading-[1.5] mb-2">
          {message}
        </div>
      )}

      {questionOptions.length > 0 && (
        <div className="flex flex-col gap-1 mb-2">
          {questionOptions.map((opt) => {
            const isSelected = selectedAnswer === opt.label;
            return (
              <label
                key={opt.label}
                className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-sm cursor-pointer text-[12.5px] transition-all duration-150
                  ${isSelected
                    ? "bg-info-muted border-info text-info"
                    : "border-border-default text-text-secondary hover:bg-bg-hover hover:border-border-strong hover:text-text-primary"
                  }`}
              >
                <span
                  className={`w-4 h-4 border-[1.5px] flex items-center justify-center text-[10px] shrink-0 rounded-full
                    ${isSelected ? "border-info bg-info text-white" : "border-border-strong"}`}
                >
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                </span>
                <input
                  type="radio"
                  name={`hitl-${item.hitlId}`}
                  value={opt.label}
                  checked={isSelected}
                  onChange={() => handleAnswerSelect(opt.label)}
                  className="sr-only"
                />
                <span className="flex-1 min-w-0">{opt.label}</span>
                {opt.description && (
                  <span className="text-[11px] text-text-muted truncate">{opt.description}</span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {reviewArtifacts.length > 0 && (
        <div className="mb-2 max-h-[120px] overflow-y-auto">
          {reviewArtifacts.map((art) => (
            <div key={art.path} className="font-mono text-[11.5px] text-text-secondary py-0.5 border-b border-border-subtle last:border-b-0">
              <span className="text-text-muted">{art.path}</span>
              {art.description && <span className="text-text-muted"> — {art.description}</span>}
            </div>
          ))}
        </div>
      )}

      <input
        type="text"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Add a comment (optional)…"
        className="w-full bg-bg-base border border-border-default rounded-sm px-2.5 py-1.5 text-[12px] text-text-primary font-sans outline-none transition-colors duration-150 focus:border-accent placeholder:text-text-muted mb-2"
      />

      <div className="flex flex-wrap gap-1.5">
        {kind === "approval" && (
          <>
            <button
              data-testid="hitl-approve-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1"
              onClick={handleApprove}
            >
              <Check size={12} /> Approve
            </button>
            <button
              data-testid="hitl-deny-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-error-muted text-error cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1"
              onClick={handleDeny}
            >
              <ShieldX size={12} /> Deny
            </button>
          </>
        )}

        {kind === "review" && (
          <>
            <button
              data-testid="hitl-approve-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1"
              onClick={handleApprove}
            >
              <Check size={12} /> Approve
            </button>
            <button
              data-testid="hitl-deny-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-error-muted text-error cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1"
              onClick={handleDeny}
            >
              <X size={12} /> Reject
            </button>
            <button
              data-testid="hitl-request-changes-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-warning-muted text-warning cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1"
              onClick={handleRequestChanges}
            >
              <RotateCcw size={12} /> Request Changes
            </button>
          </>
        )}

        {kind === "question" && (
          <button
            data-testid="hitl-approve-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-accent text-white cursor-pointer transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            onClick={handleApprove}
            disabled={questionOptions.length > 0 && !selectedAnswer}
          >
            <Check size={12} /> Submit Answer
          </button>
        )}

        <button
          data-testid="hitl-cancel-button"
          className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-bg-active text-text-muted cursor-pointer transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary flex items-center gap-1"
          onClick={handleCancel}
        >
          <X size={12} /> Cancel
        </button>
      </div>
    </div>
  );
}