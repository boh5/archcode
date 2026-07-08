import { useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ShieldCheck,
  ShieldX,
  CircleQuestionMark,
  FileSearch,
  Lock,
  TriangleAlert,
  RotateCcw,
  X,
  Check,
  Loader2,
  Bell,
} from "lucide-react";
import { useRespondHitl, useCancelHitl } from "../../api/mutations";
import type {
  HitlDisplayPayload,
  HitlOwnerKey,
  HitlProjection,
  HitlProjectionContext,
  HitlQuestionDisplayItem,
  HitlSource,
} from "../../api/types";

type SourceType = HitlSource["type"];

const SOURCE_BORDER: Record<string, string> = {
  goal_approval: "border-warning",
  goal_review: "border-accent",
  goal_budget: "border-warning",
  goal_question: "border-info",
  loop_approval: "border-warning",
  loop_blocker: "border-error",
  loop_retry: "border-warning",
  loop_question: "border-info",
  ask_user: "border-info",
  tool_permission: "border-warning",
};

const SOURCE_ICON: Record<string, typeof ShieldCheck> = {
  goal_approval: ShieldCheck,
  goal_review: FileSearch,
  goal_budget: ShieldCheck,
  goal_question: CircleQuestionMark,
  loop_approval: ShieldCheck,
  loop_blocker: TriangleAlert,
  loop_retry: RotateCcw,
  loop_question: CircleQuestionMark,
  ask_user: CircleQuestionMark,
  tool_permission: Lock,
};

const SOURCE_LABEL: Record<string, string> = {
  goal_approval: "Goal Approval",
  goal_review: "Goal Review",
  goal_budget: "Goal Budget",
  goal_question: "Goal Question",
  loop_approval: "Loop Approval",
  loop_blocker: "Loop Blocker",
  loop_retry: "Loop Retry",
  loop_question: "Loop Question",
  ask_user: "Question",
  tool_permission: "Permission",
};

function ownerLabel(owner: HitlOwnerKey): string {
  return `${owner.ownerType}`;
}

function ownerLink(owner: HitlOwnerKey, projectSlug: string): string {
  if (owner.ownerType === "session") return `/projects/${projectSlug}/sessions/${owner.ownerId}`;
  if (owner.ownerType === "goal") return `/projects/${projectSlug}/goals/${owner.ownerId}`;
  if (owner.ownerType === "loop") return `/projects/${projectSlug}/loops/${owner.ownerId}`;
  return `/projects/${projectSlug}`;
}

function ancestryLabel(ancestry: HitlProjectionContext | undefined): string | undefined {
  if (!ancestry) return undefined;
  const parts: string[] = [];
  if (ancestry.loopId) parts.push(`Loop ${ancestry.loopId}`);
  if (ancestry.goalId) parts.push(`Goal ${ancestry.goalId}`);
  if (ancestry.parentSessionId) parts.push(`Session ${ancestry.parentSessionId}`);
  return parts.length > 0 ? parts.join(" → ") : undefined;
}

interface QuestionData {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom: boolean;
}

function extractQuestions(display: HitlDisplayPayload): QuestionData[] {
  if (display.questions && display.questions.length > 0) return display.questions.map(normalizeQuestion);
  return [{ question: display.summary ?? display.title, header: "Q1", options: [], custom: true }];
}

function normalizeQuestion(question: HitlQuestionDisplayItem): QuestionData {
  return {
    question: question.question,
    header: question.header,
    options: question.options ?? [],
    ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
    custom: question.custom,
  };
}

function isQuestionSource(sourceType: SourceType): boolean {
  return sourceType === "ask_user" || sourceType === "goal_question" || sourceType === "loop_question";
}

function answerForQuestion(question: QuestionData, selectedAnswers: readonly string[], customText: string | undefined): string {
  const trimmedCustom = customText?.trim() ?? "";
  const answers = [...selectedAnswers];
  if (trimmedCustom.length > 0 && !answers.includes(trimmedCustom)) answers.push(trimmedCustom);
  if (answers.length > 0) return question.multiple ? answers.join(", ") : answers[answers.length - 1] ?? "";
  return "";
}

export interface HitlCardProps {
  projection: HitlProjection;
}

export function HitlCard({ projection }: HitlCardProps) {
  const respond = useRespondHitl();
  const cancel = useCancelHitl();
  const [comment, setComment] = useState("");
  const [answers, setAnswers] = useState<string[][]>([]);
  const [customTexts, setCustomTexts] = useState<string[]>([]);

  const source = projection.source;
  const sourceType: SourceType = source.type;
  const display = projection.displayPayload;
  const Icon = SOURCE_ICON[sourceType] ?? CircleQuestionMark;
  const borderClass = SOURCE_BORDER[sourceType] ?? "border-border-default";
  const label = SOURCE_LABEL[sourceType] ?? sourceType;
  const allowed = projection.allowedActions;

  const respondPending = respond.isPending;
  const cancelPending = cancel.isPending;
  const anyPending = respondPending || cancelPending;

  const projectSlug = projection.project.slug;
  const projectName = projection.project.name ?? projectSlug;
  const owner = projection.owner;
  const ancestry = projection.ancestry;
  const ancestryText = ancestryLabel(ancestry);

  const isQuestion = isQuestionSource(sourceType);
  const questions = useMemo(() => (isQuestion ? extractQuestions(display) : []), [isQuestion, display]);
  const resolvedAnswers = useMemo(() => questions.map((question, index) => answerForQuestion(question, answers[index] ?? [], customTexts[index])), [questions, answers, customTexts]);
  const showSummary = display.summary !== undefined && (!isQuestion || !questions.some((question) => question.question === display.summary));

  const allAnswered = isQuestion ? resolvedAnswers.every((answer) => answer.length > 0) : true;

  const handleApprove = useCallback(() => {
    if (respondPending) return;
    if (sourceType === "goal_review") {
      respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { outcome: "DONE", comment: comment || undefined } });
    } else if (sourceType === "tool_permission") {
      respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { decision: "approve_once", comment: comment || undefined } });
    } else {
      respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { decision: "approved", comment: comment || undefined } });
    }
  }, [respond, respondPending, sourceType, projectSlug, projection.hitlId, comment]);

  const handleApproveAlways = useCallback(() => {
    if (respondPending) return;
    respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { decision: "approve_always", comment: comment || undefined } });
  }, [respond, respondPending, projectSlug, projection.hitlId, comment]);

  const handleDeny = useCallback(() => {
    if (respondPending) return;
    if (sourceType === "goal_review") {
      respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { outcome: "NOT_DONE", comment: comment || undefined } });
    } else if (sourceType === "tool_permission") {
      respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { decision: "deny", comment: comment || undefined } });
    } else {
      respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { decision: "denied", comment: comment || undefined } });
    }
  }, [respond, respondPending, sourceType, projectSlug, projection.hitlId, comment]);

  const handleAnswer = useCallback(() => {
    if (respondPending || !allAnswered) return;
    respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { answers: resolvedAnswers, comment: comment || undefined } });
  }, [respond, respondPending, allAnswered, resolvedAnswers, projectSlug, projection.hitlId, comment]);

  const handleRetryResume = useCallback(() => {
    if (respondPending) return;
    respond.mutate({ projectSlug, hitlId: projection.hitlId, body: { decision: "approved", comment: comment || undefined } });
  }, [respond, respondPending, projectSlug, projection.hitlId, comment]);

  const handleCancel = useCallback(() => {
    if (cancelPending) return;
    cancel.mutate({ projectSlug, hitlId: projection.hitlId });
  }, [cancel, cancelPending, projectSlug, projection.hitlId]);

  const toggleOption = useCallback((qIndex: number, label: string, multiple?: boolean) => {
    setAnswers((prev) => {
      const next = [...prev];
      while (next.length <= qIndex) next.push([]);
      const current = [...next[qIndex]];
      if (multiple) {
        const idx = current.indexOf(label);
        if (idx >= 0) current.splice(idx, 1);
        else current.push(label);
      } else {
        current.length = 0;
        current.push(label);
        setCustomTexts((texts) => {
          const nextTexts = [...texts];
          while (nextTexts.length <= qIndex) nextTexts.push("");
          nextTexts[qIndex] = "";
          return nextTexts;
        });
      }
      next[qIndex] = current;
      return next;
    });
  }, []);

  const canApprove = allowed.includes("approve");
  const canDeny = allowed.includes("deny");
  const canAnswer = allowed.includes("answer");
  const canCancel = allowed.includes("cancel");
  const canRetryResume = allowed.includes("retry_resume");

  return (
    <div
      data-testid="hitl-card"
      className={`bg-bg-elevated border-[1.5px] ${borderClass} rounded-md px-3.5 py-2.5 shrink-0`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm shrink-0" aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="font-semibold text-[13px] text-text-primary">{label}</span>
        <span className="text-[11px] text-text-muted">— {projectName}</span>
        <span
          data-testid="hitl-status"
          className="ml-auto text-[10.5px] px-1.5 py-[1px] rounded font-medium bg-bg-active text-text-muted"
        >
          {projection.status}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-1.5 text-[10.5px] text-text-tertiary">
        <span data-testid="hitl-owner" className="font-mono">
          Owner: {ownerLabel(owner)}{" "}
          <Link
            className="text-accent hover:text-accent-hover underline-offset-2 hover:underline"
            data-testid="hitl-owner-link"
            to={ownerLink(owner, projectSlug)}
          >
            {owner.ownerId}
          </Link>
        </span>
        {ancestryText && (
          <span data-testid="hitl-ancestry" className="font-mono">
            shown via {ancestryText}
          </span>
        )}
      </div>

      <div className="text-[12.5px] text-text-primary leading-[1.55] mb-1.5" data-testid="hitl-display-title">
        {display.title}
      </div>

      {showSummary && (
        <div className="text-[12px] text-text-secondary leading-[1.5] mb-2" data-testid="hitl-display-summary">
          {display.summary}
        </div>
      )}

      {display.fields && display.fields.length > 0 && !isQuestion && (
        <div className="flex flex-col gap-0.5 mb-2 max-h-[100px] overflow-y-auto" data-testid="hitl-display-fields">
          {display.fields.map((field, idx) => (
            <div key={`${field.label}-${idx}`} className="font-mono text-[11px] text-text-muted py-0.5 border-b border-border-subtle last:border-b-0">
              <span className="text-text-tertiary">{field.label}:</span> <span className="text-text-secondary">{field.value}</span>
            </div>
          ))}
        </div>
      )}

      {isQuestion && questions.length > 0 && (
        <div className="flex flex-col gap-2 mb-2" data-testid="hitl-question-pane">
          {questions.map((q, qIndex) => (
            <div key={qIndex}>
              <div className="text-[11px] text-text-muted uppercase tracking-wide mb-1">{q.header}</div>
              <div className="text-[12.5px] text-text-primary leading-[1.55] mb-1.5">{q.question}</div>
              {q.options.length > 0 && (
                <div className="flex flex-col gap-1.5 mb-1.5">
                  {q.options.map((opt) => {
                    const selected = (answers[qIndex] ?? []).includes(opt.label);
                    return (
                      <label
                        key={opt.label}
                        className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-sm cursor-pointer text-[12.5px] transition-all duration-150
                          ${selected
                            ? "bg-accent-subtle border-accent text-accent"
                            : "border-border-default text-text-secondary hover:bg-bg-hover hover:border-border-strong hover:text-text-primary"
                          }
                        `}
                      >
                        <input
                          type={q.multiple ? "checkbox" : "radio"}
                          name={`hitl-q-${qIndex}`}
                          value={opt.label}
                          checked={selected}
                          onChange={() => toggleOption(qIndex, opt.label, q.multiple)}
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
              {q.custom !== false && (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={customTexts[qIndex] ?? ""}
                    onChange={(e) =>
                      setCustomTexts((prev) => {
                        const next = [...prev];
                        while (next.length <= qIndex) next.push("");
                        next[qIndex] = e.target.value;
                        return next;
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const text = (customTexts[qIndex] ?? "").trim();
                        if (text) toggleOption(qIndex, text, q.multiple);
                      }
                    }}
                    placeholder="Type your own answer…"
                    disabled={anyPending}
                    className="flex-1 bg-bg-base border border-border-default rounded-sm px-2.5 py-2 text-[13px] text-text-primary font-sans outline-none transition-colors duration-150 focus:border-accent placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
              )}
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
        {canAnswer && isQuestion && (
          <button
            data-testid="hitl-approve-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-accent text-white cursor-pointer transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            onClick={handleAnswer}
            disabled={anyPending || !allAnswered}
          >
            {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Submit Answer
          </button>
        )}

        {canApprove && sourceType === "tool_permission" && (
          <>
            <button
              data-testid="hitl-approve-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleApprove}
              disabled={anyPending}
            >
              {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Allow Once
            </button>
            <button
              data-testid="hitl-approve-always-button"
              className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-accent-muted text-accent cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleApproveAlways}
              disabled={anyPending}
            >
              Allow for Project
            </button>
          </>
        )}

        {canApprove && sourceType !== "tool_permission" && sourceType !== "goal_review" && !isQuestion && (
          <button
            data-testid="hitl-approve-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleApprove}
            disabled={anyPending}
          >
            {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Done
          </button>
        )}

        {canApprove && sourceType === "goal_review" && (
          <button
            data-testid="hitl-approve-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleApprove}
            disabled={anyPending}
          >
            {respondPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} DONE
          </button>
        )}

        {canDeny && sourceType === "goal_review" && (
          <button
            data-testid="hitl-deny-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-error-muted text-error cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleDeny}
            disabled={anyPending}
          >
            <X size={12} /> NOT DONE
          </button>
        )}

        {canDeny && sourceType !== "goal_review" && !isQuestion && (
          <button
            data-testid="hitl-deny-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-error-muted text-error cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleDeny}
            disabled={anyPending}
          >
            <ShieldX size={12} /> Deny
          </button>
        )}

        {canRetryResume && (
          <button
            data-testid="hitl-retry-resume-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-warning-muted text-warning cursor-pointer transition-colors duration-150 hover:opacity-90 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRetryResume}
            disabled={anyPending}
          >
            {respondPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Resume
          </button>
        )}

        {canCancel && (
          <button
            data-testid="hitl-cancel-button"
            className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-bg-active text-text-muted cursor-pointer transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleCancel}
            disabled={anyPending}
          >
            {cancelPending ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export interface HitlInboxProps {
  projections: HitlProjection[];
  isLoading?: boolean;
  emptyMessage?: string;
  title?: string;
}

export function HitlInbox({ projections, isLoading, emptyMessage = "No pending approvals", title = "Approval Queue" }: HitlInboxProps) {
  const deduped = useMemo(() => {
    const seen = new Set<string>();
    const result: HitlProjection[] = [];
    for (const p of projections) {
      if (!seen.has(p.hitlId)) {
        seen.add(p.hitlId);
        result.push(p);
      }
    }
    return result;
  }, [projections]);

  return (
    <div data-testid="hitl-inbox" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 mb-0.5">
        <Bell size={13} className="text-warning" aria-hidden="true" />
        <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">{title}</h3>
        {deduped.length > 0 && (
          <span className="bg-warning-muted text-warning px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
            {deduped.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary py-3">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Loading approval queue…
        </div>
      ) : deduped.length === 0 ? (
        <div className="text-[12.5px] text-text-tertiary py-3 border border-border-subtle rounded-md px-3.5 bg-bg-surface">
          {emptyMessage}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {deduped.map((projection) => (
            <HitlCard key={projection.hitlId} projection={projection} />
          ))}
        </div>
      )}
    </div>
  );
}
