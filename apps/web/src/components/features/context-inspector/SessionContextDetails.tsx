import { useEffect, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAutomations, useSession } from "../../../api/queries";
import { useSessionStore } from "../../../store/session-store";
import { InspectorNotice, InspectorRows, InspectorSection, InspectorValue } from "./InspectorPrimitives";

export function SessionContextDetails() {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: session, isLoading } = useSession(slug, focused);
  const { data: automations } = useAutomations(slug);
  const hydrationStatus = useSessionStore(focused, (state) => state.hydrationStatus, slug);
  const liveCwd = useSessionStore(focused, (state) => state.cwd, slug);
  const liveNextModelSelection = useSessionStore(focused, (state) => state.nextModelSelection, slug);
  const liveMessages = useSessionStore(focused, (state) => state.messages, slug);
  const liveStats = useSessionStore(focused, (state) => state.stats, slug);
  const liveExecutions = useSessionStore(focused, (state) => state.executions, slug);

  if (isLoading) return <InspectorNotice>Loading context…</InspectorNotice>;
  if (!session) return <InspectorNotice>Session context unavailable</InspectorNotice>;
  const useLiveContext = hydrationStatus === "hydrated";
  const cwd = useLiveContext ? (liveCwd ?? session.cwd) : session.cwd;
  const nextModelSelection = useLiveContext ? liveNextModelSelection : session.nextModelSelection;
  const messages = useLiveContext ? liveMessages : session.messages;
  const stats = useLiveContext ? liveStats : session.stats;
  const executions = useLiveContext ? liveExecutions : session.executions;
  const inspectedMessageId = searchParams.get("message");
  const inspectedMessage = inspectedMessageId ? messages.find((message) => message.id === inspectedMessageId) : undefined;
  const inspectedExecution = inspectedMessage?.executionId
    ? executions.find((execution) => execution.id === inspectedMessage.executionId)
    : undefined;
  const inspectedUserAudits = inspectedMessage?.executionId
    ? messages.filter((message) =>
        message.role === "user"
        && message.executionId === inspectedMessage.executionId
        && message.modelAudit !== undefined,
      )
    : [];
  const requestRows: Array<[string, string]> = inspectedMessage?.role === "user"
    ? [
        ["Requested mode", inspectedMessage.modelAudit ? formatMode(inspectedMessage.modelAudit.requested.mode) : "Not recorded"],
        ["Requested", inspectedMessage.modelAudit ? formatSelection(inspectedMessage.modelAudit.requested.selection) : "Not recorded"],
        ["Reason", formatReason(inspectedMessage.modelAudit?.reason)],
      ]
    : inspectedUserAudits.length > 0
      ? inspectedUserAudits.map((message, index) => [
          `Request ${index + 1}`,
          `${message.id} · ${formatMode(message.modelAudit!.requested.mode)} · ${formatSelection(message.modelAudit!.requested.selection)} · ${formatReason(message.modelAudit!.reason)}`,
        ])
      : [["Requests", "No associated user requests"]];
  const relatedAutomations = (automations ?? []).filter((automation) => (automation as unknown as { createdFromSessionId: string }).createdFromSessionId === focused);
  return (
    <div className="space-y-4">
      <InspectorSection title="Working directory">
        <code className="break-all text-[11px] text-text-secondary">{cwd}</code>
      </InspectorSection>
      <InspectorSection title="Model">
        {nextModelSelection
          ? <InspectorValue>{nextModelSelection.resolved.modelDisplayName}{nextModelSelection.resolved.selection.variant ? ` · ${nextModelSelection.resolved.selection.variant}` : ""}</InspectorValue>
          : <InspectorNotice>Syncing model selection…</InspectorNotice>}
      </InspectorSection>
      {inspectedMessageId && <InspectedMessageModelAudit
        messageId={inspectedMessageId}
        rows={inspectedMessage && inspectedMessage.executionId && inspectedExecution ? [
          ["Message", inspectedMessage.id],
          ["Execution", inspectedMessage.executionId],
          ["Origin", inspectedExecution.origin],
          ...requestRows,
          ["Actual", formatSelection(inspectedExecution.binding.selection)],
          ["Provider", inspectedExecution.binding.providerDisplayName],
          ["Model", inspectedExecution.binding.modelDisplayName],
          ["Resolution", inspectedExecution.binding.resolution],
          ["Runtime revision", inspectedExecution.binding.modelRuntimeRevision],
        ] : undefined}
      />}
      <InspectorSection title="Execution">
        <InspectorRows rows={[
          ["Messages", String(stats.messages.total)],
          ["Tool calls", String(stats.tools.calls)],
          ["Tokens", stats.usage.totalTokens.toLocaleString()],
          ["Executions", String(executions.length)],
        ]} />
      </InspectorSection>
      {relatedAutomations.length > 0 && (
        <InspectorSection title="Related work">
          <div className="space-y-1">
            <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Created here</div>
            {relatedAutomations.map((automation) => (
              <Link
                key={`automation-${automation.id}`}
                className="block rounded-sm px-2 py-1.5 text-xs hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                to={`/projects/${slug}/automations/${automation.id}`}
              >
                <span className="font-medium text-text-primary">{automation.name}</span>
                <span className="ml-2 text-text-muted">Automation · {automation.status}</span>
                {automation.nextFireAt && <span className="ml-2 text-text-muted">next {new Date(automation.nextFireAt).toLocaleString()}</span>}
              </Link>
            ))}
          </div>
        </InspectorSection>
      )}
    </div>
  );
}

function InspectedMessageModelAudit({
  messageId,
  rows,
}: {
  messageId: string;
  rows: Array<[string, string]> | undefined;
}) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const available = rows !== undefined;
  useEffect(() => {
    if (!available) return;
    const timeout = window.setTimeout(() => {
      sectionRef.current?.scrollIntoView?.({ block: "nearest" });
      sectionRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [available, messageId]);

  return (
    <div
      ref={sectionRef}
      id="inspected-message-model-audit"
      tabIndex={-1}
      className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <InspectorSection title="Inspected message model audit">
        {rows
          ? <InspectorRows rows={rows} />
          : <InspectorNotice>Model audit unavailable for this message</InspectorNotice>}
      </InspectorSection>
    </div>
  );
}

function formatSelection(selection: { model: string; variant?: string }): string {
  return selection.variant ? `${selection.model} · ${selection.variant}` : selection.model;
}

function formatMode(mode: "agent_default" | "session_override"): string {
  return mode === "agent_default" ? "Agent default" : "Session override";
}

function formatReason(reason: "config_invalidated" | undefined): string {
  return reason === "config_invalidated"
    ? "Requested model invalidated by configuration"
    : "Matched request";
}
