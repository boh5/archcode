import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  TOOL_DELEGATE,
  type AgentDescriptor,
  type ExecutionModelBindingSummary,
  type ProfileName,
  type ReasoningPart,
  type SessionExecutionInputCheckpoint,
  type SessionExecutionRecord,
  type SessionMessage,
  type SessionPart,
  type SystemNoticePart,
  type ToolChildSessionLink,
} from "@archcode/protocol";
import { useSessionStore } from "../../store/session-store";
import {
  buildExecutionWorkstream,
  type ExecutionWorkstreamDiagnostic,
  type ExecutionWorkstreamExecution,
} from "../../lib/execution-workstream";
import { buildDelegationCardViewModel } from "../../lib/delegation-card-model";
import { groupReadOnlyToolParts } from "../../lib/group-tools";
import { formatRelativeTime } from "../../lib/time-format";
import { executionVisualKind, presentExecutionStatus } from "../../lib/execution-status-presentation";
import { STATUS_TONE_CLASS, statusVisual } from "../../lib/status-visuals";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { ConversationRail } from "../primitives/ConversationRail";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";
import { CompressionBlock } from "./CompressionBlock";
import { DelegationCard } from "./DelegationCard";
import { GroupedToolCard } from "./GroupedToolCard";
import { RecoveryNotice } from "./RecoveryNotice";
import { ToolCard } from "./ToolCard";

const NEAR_BOTTOM_THRESHOLD_PX = 100;

interface WorkstreamUiSnapshot {
  expandedIds: Set<string>;
  knownRunningIds: Set<string>;
  initialized: boolean;
  scrollTop: number;
  nearBottom: boolean;
  hasScrollPosition: boolean;
}

const workstreamUiBySession = new Map<string, WorkstreamUiSnapshot>();
const workstreamRouteLifecycleGeneration = new Map<string, number>();

function workstreamUiKey(slug: string, routeScopeId: string, sessionId: string): string {
  return `${slug}\u0000${routeScopeId}\u0000${sessionId}`;
}

function createWorkstreamUiSnapshot(): WorkstreamUiSnapshot {
  return {
    expandedIds: new Set(),
    knownRunningIds: new Set(),
    initialized: false,
    scrollTop: 0,
    nearBottom: true,
    hasScrollPosition: false,
  };
}

function getWorkstreamUiSnapshot(slug: string, routeScopeId: string, sessionId: string): WorkstreamUiSnapshot {
  const key = workstreamUiKey(slug, routeScopeId, sessionId);
  const existing = workstreamUiBySession.get(key);
  if (existing) return existing;
  const created = createWorkstreamUiSnapshot();
  workstreamUiBySession.set(key, created);
  return created;
}

/** Route cleanup boundary: UI-only state never survives a Session route lifecycle. */
export function clearExecutionWorkstreamUiState(slug: string, routeScopeId?: string): void {
  const prefix = routeScopeId === undefined
    ? `${slug}\u0000`
    : `${slug}\u0000${routeScopeId}\u0000`;
  for (const key of workstreamUiBySession.keys()) {
    if (key.startsWith(prefix)) workstreamUiBySession.delete(key);
  }
}

/**
 * Retains UI-only state for one mounted Session route. The deferred cleanup is
 * intentionally cancellable so React Strict Mode's simulated effect teardown
 * cannot erase state from the still-mounted route.
 */
export function retainExecutionWorkstreamUiState(
  slug: string,
  routeScopeId: string,
): () => void {
  const lifecycleKey = `${slug}\u0000${routeScopeId}`;
  const generation = (workstreamRouteLifecycleGeneration.get(lifecycleKey) ?? 0) + 1;
  workstreamRouteLifecycleGeneration.set(lifecycleKey, generation);

  return () => {
    queueMicrotask(() => {
      if (workstreamRouteLifecycleGeneration.get(lifecycleKey) !== generation) return;
      workstreamRouteLifecycleGeneration.delete(lifecycleKey);
      clearExecutionWorkstreamUiState(slug, routeScopeId);
    });
  };
}

function ReasoningBlock({ part }: { part: ReasoningPart }) {
  const [expanded, setExpanded] = useState(false);
  const streaming = !part.completedAt;

  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
      <button
        type="button"
        className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-left text-[12px] text-text-tertiary hover:bg-bg-hover"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <ChevronRight size={12} className={`transition-transform duration-[var(--motion-icon)] ${expanded ? "rotate-90" : ""}`} />
        <Sparkles size={12} className={`text-text-muted ${streaming ? "animate-streaming" : ""}`} aria-hidden="true" />
        <span>{streaming ? "Thinking…" : "Reasoning"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border-subtle px-3 pb-2 text-[13px] italic leading-5 text-text-secondary">
          <MarkdownContent isStreaming={streaming}>{part.text}</MarkdownContent>
        </div>
      )}
    </div>
  );
}

function selectionLabel(selection: { model: string; variant?: string }): string {
  return selection.variant ? `${selection.model} · ${selection.variant}` : selection.model;
}

export function MsgUser({
  message,
  projectSlug = "",
  focusStoreSessionId = "",
  childSessionLinks = [],
  agentDescriptors = [],
  onInspectModelAudit,
}: {
  message: SessionMessage;
  projectSlug?: string;
  focusStoreSessionId?: string;
  childSessionLinks?: readonly ToolChildSessionLink[];
  agentDescriptors?: readonly AgentDescriptor[];
  onInspectModelAudit?: (messageId: string) => void;
}) {
  const modelChanged = message.modelAudit?.reason === "config_invalidated";

  return (
    <div className="flex min-w-0 flex-col gap-2" data-message-kind="canonical-user">
      {message.parts.map((part) => {
        if (part.type === "text") {
          return (
            <div key={part.id} className="flex justify-end">
              <div className="max-w-[640px] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-bg-active px-4 py-3 text-[13px] leading-[1.65] text-text-primary">
                {part.text}
              </div>
            </div>
          );
        }
        return (
          <div key={part.id} className="conversation-part" data-conversation-part={part.type === "tool" ? "tool" : "content"}>
            <PartRenderer
              part={part}
              projectSlug={projectSlug}
              focusStoreSessionId={focusStoreSessionId}
              childSessionLinks={childSessionLinks}
              agentDescriptors={agentDescriptors}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-end gap-x-2 text-[11px] text-text-tertiary">
        {modelChanged && message.modelAudit && (
          <span className="text-warning" data-testid={`message-model-change-${message.id}`}>
            Model changed: {selectionLabel(message.modelAudit.requested.selection)} → {selectionLabel(message.modelAudit.actual)}
          </span>
        )}
        {modelChanged && onInspectModelAudit && (
          <button
            type="button"
            className="text-text-tertiary hover:text-brand"
            onClick={() => onInspectModelAudit(message.id)}
          >
            Details
          </button>
        )}
        <time dateTime={new Date(message.createdAt).toISOString()}>{formatRelativeTime(message.createdAt)}</time>
      </div>
    </div>
  );
}

function SystemNoticeBlock({ part }: { part: SystemNoticePart }) {
  return (
    <div className="my-1 flex items-center gap-3">
      <div className="h-px flex-1 bg-border-subtle" />
      <Info size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
      <span className="text-[11px] text-text-tertiary">{part.notice}</span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

function CompactionBlock({ part }: { part: Extract<SessionPart, { type: "compaction" }> }) {
  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle bg-transparent px-3 py-2">
        <Info size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="text-[11px] font-medium text-text-tertiary">Hard context compaction</span>
        <span className="ml-auto text-[11px] text-text-tertiary">{formatRelativeTime(part.compactedAt)}</span>
      </div>
      <div className="whitespace-pre-wrap px-3 py-2 text-[12px] leading-4 text-text-secondary">
        {part.summary}
      </div>
    </div>
  );
}

function InterruptedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-warning/20 bg-warning-muted px-2 py-1 text-[11px] font-medium text-warning">
      <TriangleAlert size={12} /> Response was interrupted
    </span>
  );
}

export function PartRenderer({
  part,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors = [],
}: {
  part: SessionPart;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
  agentDescriptors?: readonly AgentDescriptor[];
}) {
  switch (part.type) {
    case "text": {
      const interrupted = (part.meta as Record<string, unknown> | undefined)?.interrupted === true;
      return (
        <div className="max-w-[740px] text-[13px] leading-[1.7] text-text-secondary">
          {interrupted && <InterruptedBadge />}
          <MarkdownContent isStreaming={!part.completedAt}>{part.text}</MarkdownContent>
        </div>
      );
    }
    case "reasoning": {
      const interrupted = (part.meta as Record<string, unknown> | undefined)?.interrupted === true;
      return (
        <div>
          {interrupted && <InterruptedBadge />}
          <ReasoningBlock part={part} />
        </div>
      );
    }
    case "tool":
      if (part.toolName === TOOL_DELEGATE) {
        return (
          <DelegationCard
            {...buildDelegationCardViewModel({
              part,
              projectSlug,
              focusStoreSessionId,
              childSessionLinks,
              agentDescriptors,
            })}
          />
        );
      }
      return <ToolCard part={part} projectSlug={projectSlug} sessionId={focusStoreSessionId} />;
    case "system-notice":
      return <SystemNoticeBlock part={part} />;
    case "compaction":
      return <CompactionBlock part={part} />;
    case "recovery-notice":
      return <RecoveryNotice part={part} />;
  }
}

function MsgAgent({
  message,
  identity,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agents,
}: {
  message: SessionMessage;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
  agents: readonly AgentDescriptor[];
}) {
  return (
    <div className="min-w-0 max-w-[740px]" data-message-kind="agent">
      <div className="msg-parts">
        {groupReadOnlyToolParts(message.parts).map((entry) => {
          const partKind = entry.type === "grouped-tools" || entry.type === "tool" ? "tool" : "content";
          if (entry.type === "grouped-tools") {
            return (
              <div key={entry.id} className="conversation-part" data-conversation-part={partKind}>
                <GroupedToolCard tools={entry.tools} projectSlug={projectSlug} sessionId={focusStoreSessionId} />
              </div>
            );
          }
          return (
            <div key={entry.id} className="conversation-part" data-conversation-part={partKind}>
              <PartRenderer
                part={entry}
                projectSlug={projectSlug}
                focusStoreSessionId={focusStoreSessionId}
                childSessionLinks={childSessionLinks}
                agentDescriptors={agents}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary" data-testid={`agent-message-meta-${message.id}`}>
        <span>{identity.displayName ?? identity.agentName}</span>
        <span aria-hidden="true">·</span>
        <span>{identity.profile}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={new Date(message.createdAt).toISOString()}>{formatRelativeTime(message.createdAt)}</time>
      </div>
    </div>
  );
}

function SessionMessageView({
  message,
  identity,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agents,
  onInspectModelAudit,
}: {
  message: SessionMessage;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
  agents: readonly AgentDescriptor[];
  onInspectModelAudit?: (messageId: string) => void;
}) {
  if (message.role === "user") {
    return (
      <MsgUser
        message={message}
        projectSlug={projectSlug}
        focusStoreSessionId={focusStoreSessionId}
        childSessionLinks={childSessionLinks}
        agentDescriptors={agents}
        onInspectModelAudit={onInspectModelAudit}
      />
    );
  }
  return (
    <MsgAgent
      message={message}
      identity={identity}
      projectSlug={projectSlug}
      focusStoreSessionId={focusStoreSessionId}
      childSessionLinks={childSessionLinks}
      agents={agents}
    />
  );
}

function formatDuration(record: SessionExecutionRecord): string {
  const durationMs = record.durationMs
    ?? (record.endedAt !== undefined ? Math.max(0, record.endedAt - record.startedAt) : Math.max(0, Date.now() - record.startedAt));
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function modelBindingLabel(binding: ExecutionModelBindingSummary): string {
  return binding.selection.variant
    ? `${binding.modelDisplayName} · ${binding.selection.variant}`
    : binding.modelDisplayName;
}

function ExecutionCard({
  execution,
  expanded,
  identity,
  projectSlug,
  focusStoreSessionId,
  agents,
  onToggle,
  onInspectModelAudit,
  checkpoint,
  continuationExecutionNumber,
}: {
  execution: ExecutionWorkstreamExecution;
  expanded: boolean;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  agents: readonly AgentDescriptor[];
  onToggle: () => void;
  onInspectModelAudit?: (messageId: string) => void;
  checkpoint?: SessionExecutionInputCheckpoint;
  continuationExecutionNumber?: number;
}) {
  const status = presentExecutionStatus(execution.record.status, checkpoint);
  const visualKind = executionVisualKind(execution.record.status, checkpoint);
  const statusTransition = useStatusTransition(execution.id, visualKind);
  const statusTone = statusVisual(visualKind).tone;
  const title = execution.title ?? "Untitled execution";
  const countLabel = [
    execution.toolCount > 0 ? `${execution.toolCount} ${execution.toolCount === 1 ? "tool" : "tools"}` : null,
    execution.childCount > 0 ? `${execution.childCount} ${execution.childCount === 1 ? "child" : "children"}` : null,
    continuationExecutionNumber === undefined ? null : `Continued in Execution ${continuationExecutionNumber}`,
  ].filter(Boolean).join(" · ");

  return (
    <article
      className={`overflow-hidden border-y border-r border-l-[3px] transition-colors duration-[var(--motion-hover)] ${execution.record.status === "running" ? "border-y-signal/40 border-r-signal/40 border-l-signal bg-signal-field" : "border-y-border-default border-r-transparent border-l-transparent bg-transparent"}`}
      data-testid={`execution-card-${execution.id}`}
      data-execution-expanded={expanded ? "true" : "false"}
      data-product-status={status.productStatus}
      data-visual-kind={visualKind}
      title={`Model: ${modelBindingLabel(execution.record.binding)}${status.detail ? ` · ${status.label}: ${status.detail}` : ""}`}
    >
      <button
        type="button"
        className="grid min-h-12 w-full grid-cols-[24px_minmax(0,1fr)_auto_18px] items-center gap-3 px-1 py-2 text-left hover:bg-bg-hover max-[520px]:grid-cols-[22px_minmax(0,1fr)_18px]"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`execution-body-${execution.id}`}
      >
        <span className={`grid h-7 w-7 place-items-center rounded-full text-[9px] font-semibold tabular-nums ${execution.record.status === "running" ? "bg-signal text-signal-ink" : "bg-bg-active text-text-tertiary"}`}>
          {execution.number}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-tertiary">
            <span className={`inline-flex items-center gap-2 text-[11px] font-semibold ${execution.record.status === "running" ? "text-signal-foreground" : STATUS_TONE_CLASS[statusTone]}`}>
              <StatusGlyph kind={visualKind} size={14} transition={statusTransition} />
              {status.label}
            </span>
            {status.detail && <span className="font-medium text-text-tertiary">· {status.detail}</span>}
            <span className="text-text-tertiary">{formatDuration(execution.record)}</span>
          </span>
          <span className="mt-1 block truncate text-[13px] font-medium text-text-primary" title={execution.title ?? undefined}>
            {title}
          </span>
        </span>
        <span className="whitespace-nowrap text-[11px] text-text-tertiary max-[520px]:hidden">
          {countLabel}
        </span>
        <ChevronDown size={15} className={`text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "" : "-rotate-90"}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div
          id={`execution-body-${execution.id}`}
          className="flex flex-col gap-4 border-t border-border-subtle px-1 py-4 sm:px-2"
          data-testid={`execution-body-${execution.id}`}
        >
          {execution.messages.map((message) => (
            <SessionMessageView
              key={message.id}
              message={message}
              identity={identity}
              projectSlug={projectSlug}
              focusStoreSessionId={focusStoreSessionId}
              childSessionLinks={execution.childSessionLinks}
              agents={agents}
              onInspectModelAudit={onInspectModelAudit}
            />
          ))}
          {execution.messages.length === 0 && (
            <div className="py-1 text-xs text-text-tertiary">No messages recorded for this execution.</div>
          )}
          {status.productStatus === "stopped" && status.detail && (
            <div
              className="rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] text-text-secondary"
              data-testid={`execution-stop-detail-${execution.id}`}
            >
              <span className="font-medium">Stop reason · {status.detail}</span>
              {execution.record.error && <span className="mt-1 block text-error">{execution.record.error}</span>}
            </div>
          )}
          {continuationExecutionNumber !== undefined && (
            <div
              className="rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] text-text-secondary"
              data-testid={`execution-continuation-${execution.id}`}
            >
              Input received · Continued in Execution {continuationExecutionNumber}
            </div>
          )}
          <div
            className="border-t border-border-subtle pt-2 font-mono text-[9px] text-text-tertiary"
            data-testid={`execution-model-${execution.id}`}
            title={`${execution.record.binding.providerDisplayName} · ${selectionLabel(execution.record.binding.selection)}`}
          >
            Model · {modelBindingLabel(execution.record.binding)}
          </div>
        </div>
      )}
    </article>
  );
}

function DiagnosticBlock({
  diagnostic,
  identity,
  projectSlug,
  focusStoreSessionId,
  agents,
  onInspectModelAudit,
}: {
  diagnostic: ExecutionWorkstreamDiagnostic;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  agents: readonly AgentDescriptor[];
  onInspectModelAudit?: (messageId: string) => void;
}) {
  const messages = diagnostic.code === "duplicate_execution" ? diagnostic.messages : [diagnostic.message];
  const title = diagnostic.code === "orphan_message"
    ? "Message is missing an Execution reference"
    : diagnostic.code === "unknown_execution"
      ? `Message references unknown Execution ${diagnostic.executionId}`
      : `Duplicate Execution id ${diagnostic.executionId}`;

  return (
    <section className="overflow-hidden rounded-md border border-error/40 bg-error-muted" data-testid={`workstream-diagnostic-${diagnostic.code}`}>
      <div className="flex items-center gap-2 border-b border-error/20 px-3 py-2 text-xs font-medium text-error">
        <CircleAlert size={14} />
        <span>{title}</span>
      </div>
      {messages.length > 0 && (
        <div className="flex flex-col gap-4 px-3 py-3">
          {messages.map((message) => (
            <SessionMessageView
              key={message.id}
              message={message}
              identity={identity}
              projectSlug={projectSlug}
              focusStoreSessionId={focusStoreSessionId}
              childSessionLinks={[]}
              agents={agents}
              onInspectModelAudit={onInspectModelAudit}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export interface ExecutionWorkstreamProps {
  slug: string;
  sessionId: string;
  routeScopeId?: string;
  sessionIdentity: { agentName: string; profile: ProfileName };
  agents: readonly AgentDescriptor[];
  onInspectModelAudit?: (messageId: string) => void;
}

export function ExecutionWorkstream({
  slug,
  sessionId,
  routeScopeId = sessionId,
  sessionIdentity,
  agents,
  onInspectModelAudit,
}: ExecutionWorkstreamProps) {
  const messages = useSessionStore(sessionId, (state) => state.messages, slug);
  const executions = useSessionStore(sessionId, (state) => state.executions, slug);
  const executionInputCheckpoints = useSessionStore(sessionId, (state) => state.executionInputCheckpoints ?? [], slug);
  const childSessionLinks = useSessionStore(sessionId, (state) => state.childSessionLinks, slug);
  const compression = useSessionStore(sessionId, (state) => state.compression, slug);
  const focusStoreSessionId = useSessionStore(sessionId, (state) => state.rootSessionId, slug);

  const projection = useMemo(() => buildExecutionWorkstream({
    messages,
    executions,
    childSessionLinks,
    compression,
    session: sessionIdentity,
    agentDescriptors: agents,
  }), [
    agents,
    childSessionLinks,
    compression,
    executions,
    messages,
    sessionIdentity.agentName,
    sessionIdentity.profile,
  ]);
  const checkpointByExecutionId = useMemo(
    () => new Map(executionInputCheckpoints.map((checkpoint) => [checkpoint.executionId, checkpoint])),
    [executionInputCheckpoints],
  );
  const executionNumberById = useMemo(
    () => new Map(projection.executions.map((execution) => [execution.id, execution.number])),
    [projection.executions],
  );

  const uiSnapshotRef = useRef(getWorkstreamUiSnapshot(slug, routeScopeId, sessionId));
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(uiSnapshotRef.current.expandedIds),
  );
  const expandedIdsRef = useRef(expandedIds);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(uiSnapshotRef.current.nearBottom);
  const renderedExpandedIds = useMemo(() => {
    const uiSnapshot = uiSnapshotRef.current;
    const next = new Set(expandedIds);
    if (!uiSnapshot.initialized && projection.executions.length > 0) {
      const defaultExecution = projection.executions.find((execution) => execution.record.status === "running")
        ?? projection.executions.at(-1);
      if (defaultExecution) next.add(defaultExecution.id);
    }
    for (const execution of projection.executions) {
      if (execution.record.status === "running" && !uiSnapshot.knownRunningIds.has(execution.id)) {
        next.add(execution.id);
      }
    }
    return next;
  }, [expandedIds, projection.executions]);

  useEffect(() => {
    const uiSnapshot = uiSnapshotRef.current;
    const runningIds = new Set(
      projection.executions
        .filter((execution) => execution.record.status === "running")
        .map((execution) => execution.id),
    );
    if (projection.executions.length > 0) uiSnapshot.initialized = true;
    uiSnapshot.knownRunningIds = runningIds;
    uiSnapshot.expandedIds = new Set(renderedExpandedIds);
    expandedIdsRef.current = renderedExpandedIds;
    if (expandedIds.size !== renderedExpandedIds.size
      || [...expandedIds].some((id) => !renderedExpandedIds.has(id))) {
      setExpandedIds(new Set(renderedExpandedIds));
    }
  }, [expandedIds, projection.executions, renderedExpandedIds]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    const uiSnapshot = uiSnapshotRef.current;
    if (!element) return;

    if (uiSnapshot.hasScrollPosition) {
      element.scrollTop = uiSnapshot.scrollTop;
      nearBottomRef.current = uiSnapshot.nearBottom;
    } else {
      element.scrollTop = element.scrollHeight;
      nearBottomRef.current = true;
    }

    return () => {
      uiSnapshot.scrollTop = element.scrollTop;
      uiSnapshot.nearBottom = nearBottomRef.current;
      uiSnapshot.hasScrollPosition = true;
      uiSnapshot.expandedIds = new Set(expandedIdsRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!nearBottomRef.current) return;
    const element = scrollerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    const uiSnapshot = uiSnapshotRef.current;
    uiSnapshot.scrollTop = element.scrollTop;
    uiSnapshot.nearBottom = true;
    uiSnapshot.hasScrollPosition = true;
  }, [compression, executions, expandedIds, messages]);

  const handleScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
    nearBottomRef.current = nearBottom;
    const uiSnapshot = uiSnapshotRef.current;
    uiSnapshot.scrollTop = element.scrollTop;
    uiSnapshot.nearBottom = nearBottom;
    uiSnapshot.hasScrollPosition = true;
  }, []);

  const toggleExecution = useCallback((executionId: string) => {
    const next = new Set(expandedIdsRef.current);
    if (next.has(executionId)) next.delete(executionId);
    else next.add(executionId);
    uiSnapshotRef.current.expandedIds = new Set(next);
    expandedIdsRef.current = next;
    setExpandedIds(next);
  }, []);

  const isEmpty = projection.items.length === 0 && projection.diagnostics.length === 0;

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="conversation-scroller min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden bg-bg-base"
      style={{ scrollbarGutter: "stable" }}
      data-testid="execution-workstream-scroller"
    >
      <ConversationRail
        className={`conversation-surface flex min-h-full flex-col py-8 max-[639px]:py-5 ${isEmpty ? "items-center justify-center" : "gap-5"}`}
        data-testid="execution-workstream-rail"
      >
        {isEmpty ? (
          <div className="text-sm text-text-tertiary">No executions yet</div>
        ) : (
          <>
            <header className="mb-1 flex items-end justify-between gap-4 border-b border-border-default px-1 pb-3">
              <div className="min-w-0">
                <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-text-muted">Session activity</div>
                <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-text-primary">Execution workstream</h2>
                <p className="mt-1 truncate text-[10px] text-text-tertiary">
                  {projection.session.displayName ?? projection.session.agentName} · {projection.session.profile}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[9px] tabular-nums text-text-tertiary">
                {projection.executions.length} {projection.executions.length === 1 ? "execution" : "executions"}
              </span>
            </header>
            {projection.diagnostics.map((diagnostic, index) => (
              <DiagnosticBlock
                key={`${diagnostic.code}-${"executionId" in diagnostic ? diagnostic.executionId : diagnostic.message.id}-${index}`}
                diagnostic={diagnostic}
                identity={projection.session}
                projectSlug={slug}
                focusStoreSessionId={focusStoreSessionId}
                agents={agents}
                onInspectModelAudit={onInspectModelAudit}
              />
            ))}
            {projection.items.map((item) => {
              if (item.kind === "execution") {
                const checkpoint = checkpointByExecutionId.get(item.id);
                const continuationExecutionNumber = checkpoint?.continuationExecutionId === undefined
                  ? undefined
                  : executionNumberById.get(checkpoint.continuationExecutionId);
                return (
                  <ExecutionCard
                    key={`execution-${item.id}`}
                    execution={item}
                    expanded={renderedExpandedIds.has(item.id)}
                    identity={projection.session}
                    projectSlug={slug}
                    focusStoreSessionId={focusStoreSessionId}
                    agents={agents}
                    checkpoint={checkpoint}
                    continuationExecutionNumber={continuationExecutionNumber}
                    onToggle={() => toggleExecution(item.id)}
                    onInspectModelAudit={onInspectModelAudit}
                  />
                );
              }
              if (item.kind === "compression") {
                return (
                  <CompressionBlock
                    key={`compression-${item.block.blockRef}-${item.id}`}
                    part={item.block}
                    projectSlug={slug}
                    sessionId={sessionId}
                    focusStoreSessionId={focusStoreSessionId}
                    snapshot={item.snapshot}
                    childSessionLinks={childSessionLinks}
                    agentDescriptors={agents}
                  />
                );
              }
              return (
                <section key={`activity-${item.id}`} className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                  <SessionMessageView
                    message={item.message}
                    identity={projection.session}
                    projectSlug={slug}
                    focusStoreSessionId={focusStoreSessionId}
                    childSessionLinks={[]}
                    agents={agents}
                    onInspectModelAudit={onInspectModelAudit}
                  />
                </section>
              );
            })}
          </>
        )}
      </ConversationRail>
    </div>
  );
}
