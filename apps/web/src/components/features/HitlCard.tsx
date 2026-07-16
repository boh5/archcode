import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, Check, ChevronRight, CircleQuestionMark, Loader2 } from "lucide-react";
import { useCancelHitl, useRespondHitl } from "../../api/mutations";
import { hitlIdentityKey, isVisibleHitlView, type ScopedHitlView } from "../../store/hitl-store";
import type { HitlDisplayPayload, HitlQuestionDisplayItem, HitlResponse, HitlSource, HitlView } from "../../api/types";

const PRIMARY_ACTION_CLASS = "rounded-md bg-text-primary px-2.5 py-1.5 text-xs font-medium text-bg-base transition-colors hover:bg-accent-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY_ACTION_CLASS = "rounded-md border border-border-default bg-transparent px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

function questions(payload: HitlDisplayPayload): HitlQuestionDisplayItem[] {
  return payload.questions?.length ? payload.questions : [{ question: payload.summary ?? payload.title, header: "Q1", custom: true }];
}

function answerForQuestion(item: HitlQuestionDisplayItem, selected: readonly string[], customAnswer: string | undefined): string {
  const custom = customAnswer?.trim() ?? "";
  const values = [...selected];
  if (custom && !values.includes(custom)) values.push(custom);
  if (item.multiple) return values.join(", ");
  return values.at(-1) ?? "";
}

function ownerLink(view: HitlView, projectSlug: string): string {
  return view.owner.type === "session"
    ? `/projects/${projectSlug}/sessions/${view.owner.id}`
    : `/projects/${projectSlug}/goals/${view.owner.id}`;
}

export function responseFor(source: HitlSource, answers: string[], decision: "approved" | "denied" | "approve_once" | "approve_always" | "deny", comment?: string): Exclude<HitlResponse, { type: "cancel" }> {
  if (source.type === "ask_user") return { type: "question_answer", answers, comment: comment || undefined };
  if (source.type === "goal_budget") return { type: "budget_decision", decision: decision === "approved" ? "approved" : "denied", comment: comment || undefined };
  return { type: "permission_decision", decision: decision as "approve_once" | "approve_always" | "deny", comment: comment || undefined };
}

export function HitlCard({ view, projectSlug, showOwnerLink = true }: { view: HitlView; projectSlug: string; showOwnerLink?: boolean }) {
  const respond = useRespondHitl();
  const cancel = useCancelHitl();
  const [comment, setComment] = useState("");
  const [answers, setAnswers] = useState<string[][]>([]);
  const [customAnswers, setCustomAnswers] = useState<string[]>([]);
  const [activeQuestionStep, setActiveQuestionStep] = useState(0);
  const items = useMemo(() => questions(view.displayPayload), [view.displayPayload]);
  const resolvedAnswers = useMemo(
    () => items.map((item, index) => answerForQuestion(item, answers[index] ?? [], customAnswers[index])),
    [answers, customAnswers, items],
  );
  const busy = respond.isPending || cancel.isPending;
  const actionable = view.allowedActions.length > 0;
  const isMultiQuestion = items.length > 1;
  const confirmStep = items.length;
  const isConfirmStep = isMultiQuestion && activeQuestionStep === confirmStep;
  const activeQuestion = activeQuestionStep < items.length ? items[activeQuestionStep] : undefined;
  const activeQuestionAnswered = (resolvedAnswers[activeQuestionStep]?.length ?? 0) > 0;
  const allAnswered = resolvedAnswers.every((answer) => answer.length > 0);
  const showSummary = view.displayPayload.summary !== undefined
    && (view.source.type !== "ask_user" || !items.some((item) => item.question === view.displayPayload.summary));

  const submit = (decision: Parameters<typeof responseFor>[2]) => {
    if (view.source.type === "ask_user" && !allAnswered) return;
    respond.mutate({ projectSlug, hitlId: view.hitlId, body: responseFor(view.source, resolvedAnswers, decision, comment) });
  };

  const toggleOption = (index: number, label: string, multiple?: boolean) => {
    setAnswers((current) => {
      const next = current.map((entry) => [...entry]);
      while (next.length <= index) next.push([]);
      const selected = next[index] ?? [];
      next[index] = multiple
        ? selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
        : [label];
      return next;
    });
    if (!multiple) {
      setCustomAnswers((current) => {
        const next = [...current];
        next[index] = "";
        return next;
      });
      if (isMultiQuestion) setActiveQuestionStep(Math.min(index + 1, confirmStep));
    }
  };

  const updateCustomAnswer = (index: number, value: string, multiple?: boolean) => {
    setCustomAnswers((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
    if (!multiple && value.length > 0) {
      setAnswers((current) => {
        const next = current.map((entry) => [...entry]);
        next[index] = [];
        return next;
      });
    }
  };

  const advanceQuestion = (index: number) => {
    if ((resolvedAnswers[index]?.length ?? 0) === 0) return;
    setActiveQuestionStep(Math.min(index + 1, confirmStep));
  };

  const renderQuestion = (item: HitlQuestionDisplayItem, index: number) => (
    <div
      id={isMultiQuestion ? `hitl-question-panel-${view.hitlId}-${index}` : undefined}
      role={isMultiQuestion ? "tabpanel" : undefined}
      aria-labelledby={isMultiQuestion ? `hitl-question-tab-${view.hitlId}-${index}` : undefined}
      data-testid="hitl-question-pane"
      className="min-w-0"
    >
      <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">{item.header}</div>
      <div className="mb-2 break-words text-[13px] leading-relaxed text-text-primary">{item.question}</div>
      {item.options?.length ? (
        <div className="mb-2 flex min-w-0 flex-col gap-1.5">
          {item.options.map((option) => {
            const selected = answers[index]?.includes(option.label) ?? false;
            return (
              <label
                key={option.label}
                className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors ${selected
                  ? "border-accent bg-accent-subtle text-text-primary"
                  : "border-border-default text-text-secondary hover:border-border-strong hover:bg-bg-hover"
                }`}
              >
                <input
                  className="sr-only"
                  type={item.multiple ? "checkbox" : "radio"}
                  name={`hitl-${view.hitlId}-q-${index}`}
                  value={option.label}
                  checked={selected}
                  onChange={() => toggleOption(index, option.label, item.multiple)}
                />
                <span className="min-w-0 flex-1 break-words font-medium">{option.label}</span>
                {option.description && <span className="min-w-0 max-w-[55%] break-words text-right text-[11px] text-text-muted">{option.description}</span>}
              </label>
            );
          })}
        </div>
      ) : null}
      {item.custom && (
        <input
          aria-label={`${item.header} custom answer`}
          className="block w-full min-w-0 rounded-md border border-border-default bg-bg-base px-2.5 py-2 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
          placeholder={item.options?.length ? "Type your own answer" : "Type your answer"}
          value={customAnswers[index] ?? ""}
          onChange={(event) => updateCustomAnswer(index, event.target.value, item.multiple)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !isMultiQuestion) return;
            event.preventDefault();
            advanceQuestion(index);
          }}
          disabled={busy}
        />
      )}
    </div>
  );

  const sourceLabel = view.source.type === "ask_user" ? "Question" : view.source.type === "tool_permission" ? "Permission" : "Budget decision";
  return (
    <article className="min-w-0 overflow-hidden rounded-[10px] border border-border-subtle bg-bg-elevated p-3" data-testid="hitl-card" data-hitl-id={view.hitlId}>
      <div className="mb-2 flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] uppercase tracking-wider text-text-muted">{sourceLabel}</div>
          <h4 className="break-words text-sm font-medium text-text-primary">{view.displayPayload.title}</h4>
        </div>
        {showOwnerLink && <Link data-testid="hitl-owner-link" className="text-xs text-accent hover:text-accent-hover" to={ownerLink(view, projectSlug)}>Open</Link>}
      </div>
      {showSummary && <p className="mb-2 break-words text-xs text-text-secondary">{view.displayPayload.summary}</p>}
      {view.displayPayload.fields?.length && view.source.type !== "ask_user" ? (
        <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          {view.displayPayload.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="contents">
              <dt className="text-text-muted">{field.label}</dt>
              <dd className="min-w-0 break-words text-text-secondary">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actionable && view.source.type === "ask_user" && isMultiQuestion && (
        <div
          className="mb-2 grid min-w-0 border-b border-border-subtle"
          style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
          role="tablist"
          aria-label="Questions"
        >
          {items.map((item, index) => {
            const selected = activeQuestionStep === index;
            const answered = (resolvedAnswers[index]?.length ?? 0) > 0;
            return (
              <button
                key={`${item.header}-${index}`}
                id={`hitl-question-tab-${view.hitlId}-${index}`}
                data-testid={`hitl-question-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`hitl-question-panel-${view.hitlId}-${index}`}
                onClick={() => setActiveQuestionStep(index)}
                className={`flex min-w-0 items-center justify-center gap-1 border-b-2 px-1.5 py-1.5 text-[11px] font-medium transition-colors ${selected
                  ? "border-accent text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-secondary"
                }`}
                title={item.header}
              >
                {answered && <Check size={11} className="shrink-0 text-success" aria-hidden="true" />}
                <span className="truncate">{item.header}</span>
              </button>
            );
          })}
          <button
            id={`hitl-confirm-tab-${view.hitlId}`}
            data-testid="hitl-confirm-tab"
            type="button"
            role="tab"
            aria-selected={isConfirmStep}
            aria-controls={`hitl-confirm-panel-${view.hitlId}`}
            onClick={() => setActiveQuestionStep(confirmStep)}
            className={`flex min-w-0 items-center justify-center gap-1 border-b-2 px-1.5 py-1.5 text-[11px] font-medium transition-colors ${isConfirmStep
              ? "border-accent text-text-primary"
              : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {allAnswered && <Check size={11} className="shrink-0 text-success" aria-hidden="true" />}
            <span className="truncate">Confirm</span>
          </button>
        </div>
      )}
      {actionable && view.source.type === "ask_user" && (
        <div className="mb-2 min-w-0">
          {isConfirmStep ? (
            <div
              id={`hitl-confirm-panel-${view.hitlId}`}
              data-testid="hitl-confirm-pane"
              role="tabpanel"
              aria-labelledby={`hitl-confirm-tab-${view.hitlId}`}
              className="flex min-w-0 flex-col gap-1.5"
            >
              <div className="text-xs font-medium text-text-primary">Review your answers</div>
              {items.map((item, index) => {
                const answer = resolvedAnswers[index] ?? "";
                return (
                  <button
                    key={`${item.header}-${index}`}
                    type="button"
                    onClick={() => setActiveQuestionStep(index)}
                    className="flex w-full min-w-0 items-start gap-2 rounded-md border border-border-subtle bg-bg-base px-2.5 py-2 text-left transition-colors hover:border-border-default hover:bg-bg-hover"
                  >
                    <span className={`mt-0.5 shrink-0 ${answer ? "text-success" : "text-warning"}`} aria-hidden="true">
                      {answer ? <Check size={13} /> : <CircleQuestionMark size={13} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[11px] text-text-muted">{item.header} · {item.question}</span>
                      <span className={`mt-0.5 block break-words text-xs ${answer ? "text-text-primary" : "text-warning"}`}>{answer || "Answer required"}</span>
                    </span>
                    <ChevronRight size={13} className="mt-1 shrink-0 text-text-muted" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : activeQuestion ? renderQuestion(activeQuestion, activeQuestionStep) : null}
        </div>
      )}
      {actionable ? <>
        {(!isMultiQuestion || isConfirmStep) && <textarea className="mb-2 block w-full min-w-0 resize-y rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent" placeholder="Comment (optional)" value={comment} onChange={(event) => setComment(event.target.value)} />}
        <div className="flex flex-wrap gap-2">
          {view.source.type === "tool_permission" && <>
            <button disabled={busy} onClick={() => submit("approve_once")} className={PRIMARY_ACTION_CLASS}>Allow once</button>
            <button disabled={busy} onClick={() => submit("approve_always")} className={SECONDARY_ACTION_CLASS}>Always allow</button>
            <button disabled={busy} onClick={() => submit("deny")} className={SECONDARY_ACTION_CLASS}>Deny</button>
          </>}
          {view.source.type === "goal_budget" && <>
            <button disabled={busy} onClick={() => submit("approved")} className={PRIMARY_ACTION_CLASS}>Approve budget</button>
            <button disabled={busy} onClick={() => submit("denied")} className={SECONDARY_ACTION_CLASS}>Deny</button>
          </>}
          {view.source.type === "ask_user" && !isMultiQuestion && <button data-testid="hitl-approve-button" disabled={busy || !allAnswered} onClick={() => submit("approved")} className={PRIMARY_ACTION_CLASS}>Submit answer</button>}
          {view.source.type === "ask_user" && isMultiQuestion && !isConfirmStep && <button data-testid="hitl-question-next-button" disabled={busy || !activeQuestionAnswered} onClick={() => advanceQuestion(activeQuestionStep)} className={PRIMARY_ACTION_CLASS}>{activeQuestionStep === items.length - 1 ? "Review answers" : "Next"}</button>}
          {view.source.type === "ask_user" && isConfirmStep && <button data-testid="hitl-approve-button" disabled={busy || !allAnswered} onClick={() => submit("approved")} className={PRIMARY_ACTION_CLASS}>Confirm Answers</button>}
          <button data-testid="hitl-cancel-button" disabled={busy} onClick={() => cancel.mutate({ projectSlug, hitlId: view.hitlId })} className={SECONDARY_ACTION_CLASS}>Cancel</button>
        </div>
        {busy && <Loader2 size={13} className="animate-spin mt-2" aria-label="Working" />}
      </> : (
        <p className="text-xs text-warning" role="status">Manual inspection is required. This request can no longer accept actions.</p>
      )}
    </article>
  );
}

export interface HitlInboxProps {
  views?: HitlView[];
  entries?: ScopedHitlView[];
  projectSlug?: string;
  isLoading?: boolean;
  emptyMessage?: string;
  hideWhenEmpty?: boolean;
  className?: string;
  testId?: string;
  title?: string;
  showOwnerLink?: boolean;
}

export function HitlInbox({ views = [], entries, projectSlug = "", isLoading, emptyMessage = "No pending requests", hideWhenEmpty = false, className = "gap-2", testId = "hitl-inbox", title = "Requests", showOwnerLink = true }: HitlInboxProps) {
  const scopedEntries = entries ?? views.map((view) => ({ projectSlug, view }));
  const visible = useMemo(() => {
    const seen = new Set<string>();
    return scopedEntries.filter((entry) => isVisibleHitlView(entry.view)).filter((entry) => { const key = hitlIdentityKey(entry.view); if (seen.has(key)) return false; seen.add(key); return true; });
  }, [scopedEntries]);
  if (hideWhenEmpty && !isLoading && visible.length === 0) return null;
  return <div data-testid={testId} className={`flex flex-col ${className}`}>
    <div className="flex items-center gap-2"><Bell size={13} className="text-warning" aria-hidden="true" /><h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">{title}</h3>{visible.length > 0 && <span className="text-xs">{visible.length}</span>}</div>
    {isLoading ? <div className="text-xs py-3"><Loader2 size={13} className="animate-spin inline" /> Loading…</div> : visible.length === 0 ? <div className="text-xs py-3">{emptyMessage}</div> : <div className="flex flex-col gap-2">{visible.map((entry) => <HitlCard key={hitlIdentityKey(entry.view)} view={entry.view} projectSlug={entry.projectSlug} showOwnerLink={showOwnerLink} />)}</div>}
  </div>;
}
