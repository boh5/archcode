import { useEffect, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAutomations, useSession } from "../../../api/queries";
import { useSessionStore } from "../../../store/session-store";
import {
  InspectorNotice,
  InspectorRows,
  InspectorSection,
} from "./InspectorPrimitives";
import { automationStatusLabel } from "../../../lib/automation-status-presentation";
import { presentExecutionStatus } from "../../../lib/execution-status-presentation";
import { useAttentionVisibleScopedHitl } from "../../../store/hitl-store";

export function SessionContextDetails() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [searchParams] = useSearchParams();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: session, isLoading } = useSession(slug, focused);
  const { data: automations } = useAutomations(slug);
  const hydrationStatus = useSessionStore(
    focused,
    (state) => state.hydrationStatus,
    slug,
  );
  const liveCwd = useSessionStore(focused, (state) => state.cwd, slug);
  const liveNextModelSelection = useSessionStore(
    focused,
    (state) => state.nextModelSelection,
    slug,
  );
  const liveMessages = useSessionStore(
    focused,
    (state) => state.messages,
    slug,
  );
  const liveStats = useSessionStore(focused, (state) => state.stats, slug);
  const liveExecutions = useSessionStore(
    focused,
    (state) => state.executions,
    slug,
  );
  const liveCurrentExecutionId = useSessionStore(
    focused,
    (state) => state.currentExecutionId,
    slug,
  );
  const liveGoal = useSessionStore(focused, (state) => state.goal, slug);
  const pendingHitl = useAttentionVisibleScopedHitl([slug]);

  if (isLoading) return <InspectorNotice>Loading context…</InspectorNotice>;
  if (!session)
    return <InspectorNotice>Session context unavailable</InspectorNotice>;
  const useLiveContext = hydrationStatus === "hydrated";
  const cwd = useLiveContext ? (liveCwd ?? session.cwd) : session.cwd;
  const nextModelSelection = useLiveContext
    ? liveNextModelSelection
    : session.nextModelSelection;
  const messages = useLiveContext ? liveMessages : session.messages;
  const stats = useLiveContext ? liveStats : session.stats;
  const executions = useLiveContext ? liveExecutions : session.executions;
  const goal = useLiveContext ? liveGoal : session.goal;
  const currentExecutionId = useLiveContext
    ? liveCurrentExecutionId
    : session.currentExecutionId;
  const currentExecution = currentExecutionId === undefined
    ? executions.at(-1)
    : executions.find((execution) => execution.id === currentExecutionId) ?? executions.at(-1);
  const gate = pendingHitl.find((entry) => entry.ownerSessionId === focused);
  const executionValue = currentExecution === undefined
    ? "Idle"
    : currentExecution.status === "suspended" && currentExecution.suspension.kind === "hitl"
      ? `Suspended · ${gate?.view.source.type === "ask_user" ? "Question" : "Permission"}`
      : (() => {
          const status = presentExecutionStatus(currentExecution);
          return status.detail ? `${status.label} · ${status.detail}` : status.label;
        })();
  const contextRows: Array<[string, string, boolean?]> = [
    ["Goal", goal ? `${formatGoalStatus(goal.status)} · ${goal.objective}` : "None · ordinary work", true],
    ["Execution", executionValue, true],
    [
      "Model",
      nextModelSelection
        ? `${nextModelSelection.resolved.modelDisplayName}${nextModelSelection.resolved.selection.variant ? ` · ${nextModelSelection.resolved.selection.variant}` : ""}`
        : "Syncing…",
    ],
    ["Tokens", stats.usage.totalTokens.toLocaleString()],
    ["Working dir", cwd],
  ];
  const inspectedMessageId = searchParams.get("message");
  const inspectedMessage = inspectedMessageId
    ? messages.find((message) => message.id === inspectedMessageId)
    : undefined;
  const inspectedExecution = inspectedMessage?.executionId
    ? executions.find(
        (execution) => execution.id === inspectedMessage.executionId,
      )
    : undefined;
  const inspectedRun =
    inspectedExecution && inspectedMessage?.runOrdinal !== undefined
      ? inspectedExecution.runs[inspectedMessage.runOrdinal]
      : undefined;
  const inspectedUserAudits = inspectedMessage?.executionId
    ? messages.filter(
        (message) =>
          message.role === "user" &&
          message.executionId === inspectedMessage.executionId &&
          message.modelAudit !== undefined,
      )
    : [];
  const requestRows: Array<[string, string]> =
    inspectedMessage?.role === "user"
      ? [
          [
            "Requested mode",
            inspectedMessage.modelAudit
              ? formatMode(inspectedMessage.modelAudit.requested.mode)
              : "Not recorded",
          ],
          [
            "Requested",
            inspectedMessage.modelAudit
              ? formatSelection(inspectedMessage.modelAudit.requested.selection)
              : "Not recorded",
          ],
          ["Reason", formatReason(inspectedMessage.modelAudit?.reason)],
        ]
      : inspectedUserAudits.length > 0
        ? inspectedUserAudits.map((message, index) => [
            `Request ${index + 1}`,
            `${message.id} · ${formatMode(message.modelAudit!.requested.mode)} · ${formatSelection(message.modelAudit!.requested.selection)} · ${formatReason(message.modelAudit!.reason)}`,
          ])
        : [["Requests", "No associated user requests"]];
  const relatedAutomations = (automations ?? []).filter(
    (automation) => automation.origin.kind !== "direct" && automation.origin.sessionId === focused,
  );
  return (
    <div>
      <dl className="px-1 py-0.5" data-testid="context-property-list">
        {contextRows.map(([label, value, priority]) => (
          <div key={label} className="grid min-h-0 grid-cols-[minmax(84px,34%)_minmax(0,1fr)] items-start gap-3 border-b border-border-subtle px-1 py-[9px] last:border-b-0">
            <dt className="text-[11.5px] font-[560] leading-[1.4] text-text-tertiary">{label}</dt>
            <dd className={`break-words text-right text-[12px] leading-[1.4] text-text-secondary ${priority ? "font-[650] text-text-primary" : "font-[560]"}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {inspectedMessageId && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <InspectedMessageModelAudit
            messageId={inspectedMessageId}
            rows={
              inspectedMessage &&
              inspectedMessage.executionId &&
              inspectedExecution
                ? [
                    ["Message", inspectedMessage.id],
                    ["Execution", inspectedMessage.executionId],
                    ["Origin", inspectedExecution.origin],
                    ...requestRows,
                    [
                      "Run",
                      inspectedRun
                        ? String(inspectedRun.ordinal + 1)
                        : "Not recorded",
                    ],
                    [
                      "Actual",
                      inspectedRun
                        ? formatSelection(inspectedRun.binding.selection)
                        : "Not recorded",
                    ],
                    [
                      "Provider",
                      inspectedRun?.binding.providerDisplayName ?? "Not recorded",
                    ],
                    [
                      "Model",
                      inspectedRun?.binding.modelDisplayName ?? "Not recorded",
                    ],
                    [
                      "Resolution",
                      inspectedRun?.binding.resolution ?? "Not recorded",
                    ],
                    [
                      "Runtime revision",
                      inspectedRun?.binding.modelRuntimeRevision ??
                        "Not recorded",
                    ],
                  ]
                : undefined
            }
          />
        </div>
      )}
      {relatedAutomations.length > 0 && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <InspectorSection title="Related work">
          <div className="space-y-1">
            <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Created here
            </div>
            {relatedAutomations.map((automation) => (
              <Link
                key={`automation-${automation.id}`}
                className="block rounded-sm px-2 py-2 text-xs hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-brand"
                to={`/projects/${slug}/automations/${automation.id}`}
              >
                <span className="font-medium text-text-primary">
                  {automation.name}
                </span>
                <span className="ml-2 text-text-tertiary">
                  Automation · {automationStatusLabel(automation.status)}
                </span>
                {automation.nextFireAt && (
                  <span className="ml-2 text-text-tertiary">
                    next {new Date(automation.nextFireAt).toLocaleString()}
                  </span>
                )}
              </Link>
            ))}
          </div>
          </InspectorSection>
        </div>
      )}
    </div>
  );
}

function formatGoalStatus(status: "active" | "paused" | "blocked" | "budget_limited" | "complete"): string {
  if (status === "budget_limited") return "Budget limited";
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
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
      className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-brand"
    >
      <InspectorSection title="Inspected message model audit">
        {rows ? (
          <InspectorRows rows={rows} />
        ) : (
          <InspectorNotice>
            Model audit unavailable for this message
          </InspectorNotice>
        )}
      </InspectorSection>
    </div>
  );
}

function formatSelection(selection: {
  model: string;
  variant?: string;
}): string {
  return selection.variant
    ? `${selection.model} · ${selection.variant}`
    : selection.model;
}

function formatMode(mode: "profile_default" | "session_override"): string {
  return mode === "profile_default" ? "Principal profile" : "Session override";
}

function formatReason(reason: "config_invalidated" | undefined): string {
  return reason === "config_invalidated"
    ? "Requested model invalidated by configuration"
    : "Matched request";
}
