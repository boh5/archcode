import { useMemo, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleQuestionMark, Loader2 } from "lucide-react";
import { useCancelHitl, useRespondHitl } from "../../api/mutations";
import type { ScopedHitlView } from "../../store/hitl-store";
import type { HitlDisplayPayload, HitlQuestionDisplayItem, HitlResponse, HitlSource } from "../../api/types";
import { IconAction } from "../primitives/IconAction";

const PRIMARY_ACTION_CLASS = "h-8 rounded-sm bg-text-primary px-3 text-[12px] font-medium leading-4 text-bg-base transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY_ACTION_CLASS = "h-8 rounded-sm border border-border-default bg-transparent px-3 text-[12px] font-medium leading-4 text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";

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

export function responseFor(source: HitlSource, answers: string[], decision: "approved" | "denied" | "approve_once" | "approve_always" | "deny", comment?: string): Exclude<HitlResponse, { type: "cancel" }> {
  if (source.type === "ask_user") return { type: "question_answer", answers, comment: comment || undefined };
  return { type: "permission_decision", decision: decision as "approve_once" | "approve_always" | "deny", comment: comment || undefined };
}

/** The only HITL mutation surface: rendered in the owning root Session composer. */
export function HitlDecisionCard({
  entry,
  requestPosition = 1,
  requestCount = 1,
  onPreviousRequest,
  onNextRequest,
}: {
  entry: ScopedHitlView;
  requestPosition?: number;
  requestCount?: number;
  onPreviousRequest?: () => void;
  onNextRequest?: () => void;
}) {
  const { projectSlug, view } = entry;
  const respond = useRespondHitl();
  const cancel = useCancelHitl();
  const [comment, setComment] = useState("");
  const [answers, setAnswers] = useState<string[][]>([]);
  const [customAnswers, setCustomAnswers] = useState<string[]>([]);
  const [activeQuestionStep, setActiveQuestionStep] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const items = useMemo(() => questions(view.displayPayload), [view.displayPayload]);
  const resolvedAnswers = useMemo(
    () => items.map((item, index) => answerForQuestion(item, answers[index] ?? [], customAnswers[index])),
    [answers, customAnswers, items],
  );
  const busy = respond.isPending || cancel.isPending;
  const mutationError = respond.error ?? cancel.error;
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

  const questionTabId = (step: number) => step === confirmStep
    ? `hitl-confirm-tab-${view.hitlId}`
    : `hitl-question-tab-${view.hitlId}-${step}`;

  const selectQuestionStep = (step: number, focus = false) => {
    setActiveQuestionStep(step);
    if (focus) requestAnimationFrame(() => document.getElementById(questionTabId(step))?.focus());
  };

  const handleQuestionTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, step: number) => {
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = (step - 1 + items.length + 1) % (items.length + 1);
    if (event.key === "ArrowRight") next = (step + 1) % (items.length + 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = confirmStep;
    if (next === undefined) return;
    event.preventDefault();
    selectQuestionStep(next, true);
  };

  const renderQuestion = (item: HitlQuestionDisplayItem, index: number) => (
    <div
      id={isMultiQuestion ? `hitl-question-panel-${view.hitlId}-${index}` : undefined}
      role={isMultiQuestion ? "tabpanel" : undefined}
      aria-labelledby={isMultiQuestion ? `hitl-question-tab-${view.hitlId}-${index}` : undefined}
      data-testid="hitl-question-pane"
      className="min-w-0"
    >
      <fieldset disabled={busy}>
        <legend className="mb-2 block w-full break-words text-[13px] font-medium leading-5 text-text-primary">
          {item.question}
          {item.multiple && <span className="ml-1 font-normal text-text-tertiary">(select all that apply)</span>}
        </legend>
        {item.options?.length ? (
          <div className="mb-2 flex min-w-0 flex-col gap-1" data-testid="hitl-option-list">
            {item.options.map((option) => {
              const selected = answers[index]?.includes(option.label) ?? false;
              return (
                <label
                  key={option.label}
                  className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors focus-within:ring-2 focus-within:ring-brand ${selected
                    ? "bg-brand-subtle text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover"
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
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${item.multiple ? "rounded-sm" : "rounded-full"} ${selected
                      ? "border-brand bg-brand text-bg-base"
                      : "border-border-strong bg-bg-base"
                    }`}
                    aria-hidden="true"
                  >
                    {selected && (item.multiple
                      ? <Check size={11} strokeWidth={2.5} />
                      : <span className="h-1.5 w-1.5 rounded-full bg-current" />)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium leading-5">{option.label}</span>
                    {option.description && <span className="block break-words text-[11px] leading-4 text-text-tertiary">{option.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
      </fieldset>
      {item.custom && (
        <input
          aria-label={`${item.header} custom answer`}
          className="block min-h-10 w-full min-w-0 rounded-sm border border-border-control bg-bg-base px-3 text-[12px] leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-brand focus:ring-2 focus:ring-brand-subtle"
          placeholder={item.options?.length ? "Other answer…" : "Type your answer…"}
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

  return (
    <article
      id={`hitl-decision-${view.hitlId}`}
      className="min-w-0 rounded-sm border-y border-r border-border-subtle border-l-[3px] border-l-warning bg-bg-elevated outline-none transition-colors focus-visible:bg-warning-muted"
      data-testid="hitl-decision-card"
      data-hitl-id={view.hitlId}
    >
      <div className="min-w-0 px-3 py-2" data-testid="hitl-decision-body">
        {view.source.type === "tool_permission" && (
          <h4 className="mb-1 break-words text-[13px] font-medium leading-5 text-text-primary">{view.displayPayload.title}</h4>
        )}
        {showSummary && <p className="mb-1.5 break-words text-xs leading-5 text-text-secondary">{view.displayPayload.summary}</p>}
        {view.displayPayload.fields?.length && view.source.type !== "ask_user" ? (
          <div className="mb-2">
            <button
              type="button"
              aria-expanded={detailsOpen}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <ChevronDown size={12} className={`transition-transform ${detailsOpen ? "rotate-180" : ""}`} aria-hidden="true" />
              {detailsOpen ? "Hide operation details" : "Show operation details"}
            </button>
            {detailsOpen && (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                {view.displayPayload.fields.map((field, index) => (
                  <div key={`${field.label}-${index}`} className="contents">
                    <dt className="text-text-tertiary">{field.label}</dt>
                    <dd className="min-w-0 break-words font-mono text-[11px] text-text-secondary">{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ) : null}
        {actionable && view.source.type === "ask_user" && isMultiQuestion && (
          <div
            className="flex min-w-0 flex-wrap items-center gap-1"
            role="tablist"
            aria-label="Question steps"
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
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectQuestionStep(index)}
                  onKeyDown={(event) => handleQuestionTabKeyDown(event, index)}
                  className={`flex min-h-8 min-w-0 items-center justify-center gap-1 rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${selected
                    ? "border-border-default bg-bg-active text-text-primary"
                    : "border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
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
              tabIndex={isConfirmStep ? 0 : -1}
              onClick={() => selectQuestionStep(confirmStep)}
              onKeyDown={(event) => handleQuestionTabKeyDown(event, confirmStep)}
              className={`flex min-h-8 min-w-0 items-center justify-center gap-1 rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${isConfirmStep
                ? "border-border-default bg-bg-active text-text-primary"
                : "border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
            >
              {allAnswered && <Check size={11} className="shrink-0 text-success" aria-hidden="true" />}
              <span className="truncate">Confirm</span>
            </button>
          </div>
        )}
        {actionable && view.source.type === "ask_user" && (
          <div className={`min-w-0 ${isMultiQuestion ? "mt-2" : ""}`}>
            {isConfirmStep ? (
              <div
                id={`hitl-confirm-panel-${view.hitlId}`}
                data-testid="hitl-confirm-pane"
                role="tabpanel"
                aria-labelledby={`hitl-confirm-tab-${view.hitlId}`}
                className="flex min-w-0 flex-col"
              >
                <div className="mb-1 text-[13px] font-medium leading-5 text-text-primary">Review your answers</div>
                {items.map((item, index) => {
                  const answer = resolvedAnswers[index] ?? "";
                  return (
                    <button
                      key={`${item.header}-${index}`}
                      type="button"
                      onClick={() => selectQuestionStep(index)}
                      className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <span className={`shrink-0 ${answer ? "text-success" : "text-warning"}`} aria-hidden="true">
                        {answer ? <Check size={13} /> : <CircleQuestionMark size={13} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10px] text-text-tertiary">{item.header} · {item.question}</span>
                        <span className={`block truncate text-xs ${answer ? "text-text-primary" : "text-warning"}`}>{answer || "Answer required"}</span>
                      </span>
                      <ChevronRight size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            ) : activeQuestion ? renderQuestion(activeQuestion, activeQuestionStep) : null}
          </div>
        )}
        {commentOpen && actionable && (!isMultiQuestion || isConfirmStep) && (
          <textarea
            aria-label="Optional note"
            className="mt-2 block min-h-16 w-full min-w-0 resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 text-[12px] leading-4 text-text-primary outline-none placeholder:text-text-muted focus:border-brand focus:ring-2 focus:ring-brand-subtle"
            placeholder="Add context for this decision (optional)"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        )}
        {busy && <Loader2 size={13} className="mt-2 animate-activity" aria-label="Working" />}
        {mutationError && <p className="mt-2 text-xs text-error" role="alert">{mutationError instanceof Error ? mutationError.message : "Could not update this request. Please try again."}</p>}
        {!actionable && <p className="text-xs text-warning" role="status">Manual inspection is required. This request can no longer accept actions.</p>}
      </div>

      {(actionable || requestCount > 1) && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-bg-surface px-3 py-2" data-testid="hitl-decision-actions">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {requestCount > 1 && (
              <div className="flex items-center gap-1" data-testid="hitl-request-navigator">
                <span className="mr-0.5 whitespace-nowrap font-mono text-[10px] tabular-nums text-text-tertiary">
                  {requestPosition}/{requestCount}
                </span>
                <IconAction label="Previous request" disabled={requestPosition <= 1} onClick={onPreviousRequest}>
                  <ChevronLeft size={13} aria-hidden="true" />
                </IconAction>
                <IconAction label="Next request" disabled={requestPosition >= requestCount} onClick={onNextRequest}>
                  <ChevronRight size={13} aria-hidden="true" />
                </IconAction>
              </div>
            )}
            {actionable && (!isMultiQuestion || isConfirmStep) && (
              <button
                type="button"
                className="text-[11px] font-medium text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-expanded={commentOpen}
                onClick={() => setCommentOpen((open) => !open)}
              >
                {commentOpen ? "Hide note" : "Add note"}
              </button>
            )}
            {actionable && <button
              data-testid="hitl-cancel-button"
              disabled={busy}
              onClick={() => cancel.mutate({ projectSlug, hitlId: view.hitlId })}
              className="text-[11px] font-medium text-text-tertiary hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel request
            </button>}
          </div>
          {actionable && <div className="ml-auto flex flex-wrap justify-end gap-2">
            {view.source.type === "tool_permission" && <>
              <button disabled={busy} onClick={() => submit("deny")} className={SECONDARY_ACTION_CLASS}>Deny</button>
              {view.persistentApprovalEligible === true && (
                <button
                  disabled={busy}
                  onClick={() => submit("approve_always")}
                  className={SECONDARY_ACTION_CLASS}
                  title="Save approval for this project's exact operation scope"
                >
                  Always allow
                </button>
              )}
              <button disabled={busy} onClick={() => submit("approve_once")} className={PRIMARY_ACTION_CLASS}>Allow once</button>
            </>}
            {view.source.type === "ask_user" && !isMultiQuestion && <button data-testid="hitl-approve-button" disabled={busy || !allAnswered} onClick={() => submit("approved")} className={PRIMARY_ACTION_CLASS}>Submit answer</button>}
            {view.source.type === "ask_user" && isMultiQuestion && !isConfirmStep && <button data-testid="hitl-question-next-button" disabled={busy || !activeQuestionAnswered} onClick={() => advanceQuestion(activeQuestionStep)} className={PRIMARY_ACTION_CLASS}>{activeQuestionStep === items.length - 1 ? "Review answers" : "Next"}</button>}
            {view.source.type === "ask_user" && isConfirmStep && <button data-testid="hitl-approve-button" disabled={busy || !allAnswered} onClick={() => submit("approved")} className={PRIMARY_ACTION_CLASS}>Confirm Answers</button>}
          </div>}
        </footer>
      )}
    </article>
  );
}
