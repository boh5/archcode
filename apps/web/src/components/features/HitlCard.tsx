import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, Loader2 } from "lucide-react";
import { useCancelHitl, useRespondHitl } from "../../api/mutations";
import { hitlIdentityKey, isVisibleHitlView, type ScopedHitlView } from "../../store/hitl-store";
import type { HitlDisplayPayload, HitlQuestionDisplayItem, HitlResponse, HitlSource, HitlView } from "../../api/types";

function questions(payload: HitlDisplayPayload): HitlQuestionDisplayItem[] {
  return payload.questions?.length ? payload.questions : [{ question: payload.summary ?? payload.title, header: "Q1", custom: true }];
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

export function HitlCard({ view, projectSlug }: { view: HitlView; projectSlug: string }) {
  const respond = useRespondHitl();
  const cancel = useCancelHitl();
  const [comment, setComment] = useState("");
  const [answers, setAnswers] = useState<string[][]>([]);
  const [customAnswers, setCustomAnswers] = useState<string[]>([]);
  const items = useMemo(() => questions(view.displayPayload), [view.displayPayload]);
  const busy = respond.isPending || cancel.isPending;
  const actionable = view.allowedActions.length > 0;
  const submit = (decision: Parameters<typeof responseFor>[2]) => {
    const flattened = items.map((_, index) => {
      const custom = customAnswers[index]?.trim();
      return [...(answers[index] ?? []), ...(custom ? [custom] : [])].join(", ");
    });
    if (view.source.type === "ask_user" && flattened.some((answer) => answer.trim().length === 0)) return;
    respond.mutate({ projectSlug, hitlId: view.hitlId, body: responseFor(view.source, flattened, decision, comment) });
  };
  const sourceLabel = view.source.type === "ask_user" ? "Question" : view.source.type === "tool_permission" ? "Permission" : "Budget decision";
  return (
    <article className="border border-border-subtle rounded-md bg-bg-surface p-3" data-testid="hitl-card" data-hitl-id={view.hitlId}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div className="text-[12px] uppercase tracking-wider text-text-muted">{sourceLabel}</div>
          <h4 className="text-sm font-medium text-text-primary">{view.displayPayload.title}</h4>
        </div>
        <Link data-testid="hitl-owner-link" className="text-xs text-accent" to={ownerLink(view, projectSlug)}>Open</Link>
      </div>
      {view.displayPayload.summary && <p className="text-xs text-text-secondary mb-2">{view.displayPayload.summary}</p>}
      {view.displayPayload.fields?.length ? (
        <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          {view.displayPayload.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="contents">
              <dt className="text-text-muted">{field.label}</dt>
              <dd className="min-w-0 break-words text-text-secondary">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actionable && view.source.type === "ask_user" && items.map((item, index) => (
        <div key={`${item.header}-${index}`} className="mb-2">
          <label className="block text-xs text-text-secondary mb-1">{item.question}</label>
          {item.options?.map((option) => (
            <label key={option.label} className="flex items-center gap-2 text-xs py-0.5">
              <input type={item.multiple ? "checkbox" : "radio"} name={`${view.hitlId}-${index}`} checked={answers[index]?.includes(option.label) ?? false} onChange={() => setAnswers((current) => { const next = current.map((entry) => [...entry]); const selected = next[index] ?? []; next[index] = selected.includes(option.label) ? selected.filter((value) => value !== option.label) : item.multiple ? [...selected, option.label] : [option.label]; return next; })} />
              {option.label}
            </label>
          ))}
          {item.custom && (
            <input
              aria-label={`${item.header} custom answer`}
              className="mt-1 w-full border rounded px-2 py-1 text-xs"
              placeholder={item.options?.length ? "Type your own answer" : undefined}
              value={customAnswers[index] ?? ""}
              onChange={(event) => setCustomAnswers((current) => {
                const next = [...current];
                next[index] = event.target.value;
                return next;
              })}
            />
          )}
        </div>
      ))}
      {actionable ? <>
        <textarea className="w-full border rounded px-2 py-1 text-xs mb-2" placeholder="Comment (optional)" value={comment} onChange={(event) => setComment(event.target.value)} />
        <div className="flex gap-2">
          {view.source.type === "tool_permission" && <>
            <button disabled={busy} onClick={() => submit("approve_once")} className="btn-primary text-xs">Allow once</button>
            <button disabled={busy} onClick={() => submit("approve_always")} className="btn-secondary text-xs">Always allow</button>
            <button disabled={busy} onClick={() => submit("deny")} className="btn-secondary text-xs">Deny</button>
          </>}
          {view.source.type === "goal_budget" && <>
            <button disabled={busy} onClick={() => submit("approved")} className="btn-primary text-xs">Approve budget</button>
            <button disabled={busy} onClick={() => submit("denied")} className="btn-secondary text-xs">Deny</button>
          </>}
          {view.source.type === "ask_user" && <button disabled={busy} onClick={() => submit("approved")} className="btn-primary text-xs">Submit answer</button>}
          <button data-testid="hitl-cancel-button" disabled={busy} onClick={() => cancel.mutate({ projectSlug, hitlId: view.hitlId })} className="btn-secondary text-xs">Cancel</button>
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
}

export function HitlInbox({ views = [], entries, projectSlug = "", isLoading, emptyMessage = "No pending requests", hideWhenEmpty = false, className = "gap-2", testId = "hitl-inbox", title = "Requests" }: HitlInboxProps) {
  const scopedEntries = entries ?? views.map((view) => ({ projectSlug, view }));
  const visible = useMemo(() => {
    const seen = new Set<string>();
    return scopedEntries.filter((entry) => isVisibleHitlView(entry.view)).filter((entry) => { const key = hitlIdentityKey(entry.view); if (seen.has(key)) return false; seen.add(key); return true; });
  }, [scopedEntries]);
  if (hideWhenEmpty && !isLoading && visible.length === 0) return null;
  return <div data-testid={testId} className={`flex flex-col ${className}`}>
    <div className="flex items-center gap-2"><Bell size={13} className="text-warning" aria-hidden="true" /><h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">{title}</h3>{visible.length > 0 && <span className="text-xs">{visible.length}</span>}</div>
    {isLoading ? <div className="text-xs py-3"><Loader2 size={13} className="animate-spin inline" /> Loading…</div> : visible.length === 0 ? <div className="text-xs py-3">{emptyMessage}</div> : <div className="flex flex-col gap-2">{visible.map((entry) => <HitlCard key={hitlIdentityKey(entry.view)} view={entry.view} projectSlug={entry.projectSlug} />)}</div>}
  </div>;
}
