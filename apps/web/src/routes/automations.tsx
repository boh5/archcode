import { Link, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useAutomationInvocations, useAutomations } from "../api/queries";
import { useCreateSession, usePostMessage } from "../api/mutations";
import type { Automation, AutomationTrigger } from "../api/types";
import { automationHitlSessionCount, deriveAutomationHitlAttention } from "../lib/automation-hitl-attention";
import { hitlAttentionPath, useAttentionVisibleScopedHitl } from "../store/hitl-store";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { automationStatusLabel, automationVisualKind } from "../lib/automation-status-presentation";

export function AutomationsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useAutomations(slug);
  const createSession = useCreateSession();
  const postMessage = usePostMessage();
  const startAutomationSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId}`);
        postMessage.mutate({
          slug,
          sessionId: session.sessionId,
          content: "/skill use automation-create",
          requestedModelSelection: session.nextModelSelection.requested,
        });
      },
    });
  };
  return <div className="flex h-full flex-col"><header className="flex h-12 items-center justify-between border-b border-border-subtle px-4"><h1 className="text-[16px] font-semibold leading-[22px]">Automations</h1><button onClick={startAutomationSession} disabled={createSession.isPending} className="inline-flex h-8 items-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"><Plus aria-hidden="true" size={14} /> New Automation</button></header>
    <main className="flex-1 overflow-y-auto">{isLoading ? <p className="p-4 text-text-tertiary">Loading automations…</p> : error ? <p className="p-4 text-error">Failed to load automations</p> : !data?.length ? <div className="flex h-full flex-col items-center justify-center gap-3"><h2 className="text-[14px] font-semibold leading-5">No automations yet</h2><p className="max-w-sm text-center text-sm text-text-tertiary">Schedule a normal Session message for later or on a recurring cadence.</p><button onClick={startAutomationSession} disabled={createSession.isPending} className="inline-flex h-8 items-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"><Plus aria-hidden="true" size={14} /> New Automation</button></div> : data.map((automation) => <AutomationRow key={automation.id} slug={slug} automation={automation} />)}</main>
  </div>;
}

function AutomationRow({ slug, automation }: { slug: string; automation: Automation }) {
  const invocations = useAutomationInvocations(slug, automation.id);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const attention = deriveAutomationHitlAttention(automation, invocations.data ?? [], scopedHitl);
  const attentionCount = automationHitlSessionCount(attention);
  const firstEntry = attention.kind === "start_session"
    ? attention.sessions[0]?.entries[0]
    : attention.entries[0];
  const statusLabel = automationStatusLabel(automation.status);

  return (
    <div className="border-b border-border-subtle px-4 py-3 hover:bg-bg-hover">
      <div className="flex items-center justify-between gap-3">
        <Link className="font-medium hover:text-brand" to={`/projects/${slug}/automations/${automation.id}`}>
          {automation.name}
        </Link>
        <span className="inline-flex items-center gap-2 text-xs text-text-tertiary">
          <StatusGlyph kind={automationVisualKind(automation.status)} label={`Automation ${statusLabel}`} size={13} />
          {statusLabel}
        </span>
      </div>
      <div className="mt-1 text-[11px] leading-4 text-text-tertiary">
        {formatTrigger(automation.trigger)} · {automation.action.kind === "start_session" ? "Start Session" : "Send message"}
        {automation.nextFireAt ? ` · next ${new Date(automation.nextFireAt).toLocaleString()}` : ""}
      </div>
      {attentionCount > 0 && firstEntry ? (
        <Link className="mt-2 inline-flex text-xs font-medium text-warning hover:text-text-primary" to={hitlAttentionPath(firstEntry)}>
          {attention.kind === "start_session" ? `${attentionCount} Sessions need attention` : "Target Session needs attention"}
        </Link>
      ) : null}
    </div>
  );
}

export function formatTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "once") return `Once ${new Date(trigger.at).toLocaleString()}`;
  if (trigger.kind === "interval") return `Every ${trigger.everyMs} ms`;
  return `Cron ${trigger.expression} (${trigger.timezone})`;
}
