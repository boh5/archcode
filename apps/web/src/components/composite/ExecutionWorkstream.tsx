import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  CircleAlert,
  Info,
  TriangleAlert,
} from "lucide-react";
import {
  TOOL_DELEGATE,
  type AgentDescriptor,
  type ExecutionModelBindingSummary,
  type ProfileName,
  type SessionExecutionInputCheckpoint,
  type SessionExecutionRecord,
  type SessionMessage,
  type SessionPart,
  type SystemNoticePart,
  type TextPart,
  type ToolChildSessionLink,
} from "@archcode/protocol";
import { useSessionStore } from "../../store/session-store";
import {
  buildExecutionWorkstream,
  type ExecutionWorkstreamDiagnostic,
  type ExecutionWorkstreamExecution,
  type ExecutionWorkstreamProjection,
  stabilizeExecutionWorkstreamProjection,
} from "../../lib/execution-workstream";
import { buildDelegationCardViewModel } from "../../lib/delegation-card-model";
import { buildToolRunTimeline } from "../../lib/tool-runs";
import { formatRelativeTime } from "../../lib/time-format";
import { executionVisualKind, presentExecutionStatus } from "../../lib/execution-status-presentation";
import { STATUS_TONE_CLASS, statusVisual } from "../../lib/status-visuals";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { ConversationRail } from "../primitives/ConversationRail";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";
import { CompressionBlock } from "./CompressionBlock";
import { DelegationCard } from "./DelegationCard";
import { ReasoningBlock } from "./ReasoningBlock";
import { RecoveryNotice } from "./RecoveryNotice";
import { ToolCard } from "./ToolCard";
import { ToolRunCard } from "./ToolRunCard";

const NEAR_BOTTOM_THRESHOLD_PX = 100;

interface WorkstreamUiSnapshot {
  expandedIds: Set<string>;
  manualOverrideIds: Set<string>;
  statusByExecutionId: Map<string, SessionExecutionRecord["status"]>;
  scrollTop: number;
  nearBottom: boolean;
  hasScrollPosition: boolean;
}

const workstreamUiBySession = new Map<string, WorkstreamUiSnapshot>();
const workstreamRouteLifecycleGeneration = new Map<string, number>();
let executionTurnRenderObserverForTest: ((executionId: string) => void) | undefined;

/** Test-only render isolation probe; production leaves it undefined. */
export function __setExecutionTurnRenderObserverForTest(
  observer: ((executionId: string) => void) | undefined,
): void {
  executionTurnRenderObserverForTest = observer;
}

function workstreamUiKey(slug: string, routeScopeId: string, sessionId: string): string {
  return `${slug}\u0000${routeScopeId}\u0000${sessionId}`;
}

function createWorkstreamUiSnapshot(): WorkstreamUiSnapshot {
  return {
    expandedIds: new Set(),
    manualOverrideIds: new Set(),
    statusByExecutionId: new Map(),
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

function selectionLabel(selection: { model: string; variant?: string }): string {
  return selection.variant ? `${selection.model} · ${selection.variant}` : selection.model;
}

export function MsgUser({
  message,
  parts = message.parts,
  projectSlug = "",
  focusStoreSessionId = "",
  childSessionLinks = [],
  agentDescriptors = [],
  onInspectModelAudit,
}: {
  message: SessionMessage;
  parts?: readonly SessionPart[];
  projectSlug?: string;
  focusStoreSessionId?: string;
  childSessionLinks?: readonly ToolChildSessionLink[];
  agentDescriptors?: readonly AgentDescriptor[];
  onInspectModelAudit?: (messageId: string) => void;
}) {
  const modelChanged = message.modelAudit?.reason === "config_invalidated";

  return (
    <div className="flex min-w-0 flex-col gap-2" data-message-kind="canonical-user">
      {parts.map((part) => {
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
  parts = message.parts,
  showMeta = true,
  identity,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agents,
}: {
  message: SessionMessage;
  parts?: readonly SessionPart[];
  showMeta?: boolean;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
  agents: readonly AgentDescriptor[];
}) {
  return (
    <div className="min-w-0 max-w-[740px]" data-message-kind="agent">
      <div className="msg-parts">
        {parts.map((entry) => {
          const partKind = entry.type === "tool" ? "tool" : "content";
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
      {showMeta && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary" data-testid={`agent-message-meta-${message.id}`}>
          <span>{identity.displayName ?? identity.agentName}</span>
          <span aria-hidden="true">·</span>
          <span>{identity.profile}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(message.createdAt).toISOString()}>{formatRelativeTime(message.createdAt)}</time>
        </div>
      )}
    </div>
  );
}

function SessionMessageView({
  message,
  parts = message.parts,
  showMeta = true,
  identity,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agents,
  onInspectModelAudit,
}: {
  message: SessionMessage;
  parts?: readonly SessionPart[];
  showMeta?: boolean;
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
        parts={parts}
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
      parts={parts}
      showMeta={showMeta}
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

function FinalAgentResponse({
  message,
  textParts,
  identity,
}: {
  message: SessionMessage;
  textParts: readonly TextPart[];
  identity: { agentName: string; displayName?: string; profile: ProfileName };
}) {
  const text = textParts.map((part) => part.text).join("");

  return (
    <section
      className="min-w-0 max-w-[740px]"
      data-message-kind="agent"
      data-testid={`final-response-${message.executionId ?? message.id}`}
    >
      <div className="msg-parts">
        <div className="conversation-part" data-conversation-part="content">
          <div className="max-w-[740px] text-[13px] leading-[1.7] text-text-secondary">
            <MarkdownContent>{text}</MarkdownContent>
          </div>
        </div>
      </div>
      <div
        className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary"
        data-testid={`agent-message-meta-${message.id}`}
      >
        <span>{identity.displayName ?? identity.agentName}</span>
        <span aria-hidden="true">·</span>
        <span>{identity.profile}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={new Date(message.createdAt).toISOString()}>{formatRelativeTime(message.createdAt)}</time>
      </div>
    </section>
  );
}

function WorkDisclosure({
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
  buttonRef,
}: {
  execution: ExecutionWorkstreamExecution;
  expanded: boolean;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  agents: readonly AgentDescriptor[];
  onToggle: (button: HTMLButtonElement) => void;
  onInspectModelAudit?: (messageId: string) => void;
  checkpoint?: SessionExecutionInputCheckpoint;
  continuationExecutionNumber?: number;
  buttonRef: (button: HTMLButtonElement | null) => void;
}) {
  const timeline = useMemo(
    () => buildToolRunTimeline(execution.workMessages),
    [execution.workMessages],
  );
  const status = presentExecutionStatus(execution.record.status, checkpoint);
  const visualKind = executionVisualKind(execution.record.status, checkpoint);
  const statusTransition = useStatusTransition(execution.id, visualKind);
  const statusTone = statusVisual(visualKind).tone;
  const duration = formatDuration(execution.record);
  const primaryLabel = execution.record.status === "running"
    ? `Working · ${duration}`
    : execution.record.status === "completed"
      ? `Worked for ${duration}`
      : status.label;
  const metadata = [
    `Execution ${execution.number}`,
    execution.stepCount > 0 ? `${execution.stepCount} ${execution.stepCount === 1 ? "step" : "steps"}` : null,
    execution.toolCount > 0 ? `${execution.toolCount} ${execution.toolCount === 1 ? "tool" : "tools"}` : null,
    execution.childCount > 0 ? `${execution.childCount} ${execution.childCount === 1 ? "child" : "children"}` : null,
    continuationExecutionNumber === undefined ? null : `Continued in Execution ${continuationExecutionNumber}`,
  ].filter(Boolean).join(" · ");
  const accessibleName = [primaryLabel, status.detail, metadata].filter(Boolean).join(", ");

  return (
    <section
      className={`min-w-0 border-y border-border-default ${execution.record.status === "running" ? "border-l-[3px] border-l-signal bg-signal-field" : "border-l-[3px] border-l-transparent bg-transparent"}`}
      data-testid={`work-disclosure-${execution.id}`}
      data-work-expanded={expanded ? "true" : "false"}
      data-product-status={status.productStatus}
      data-visual-kind={visualKind}
      title={`Model: ${modelBindingLabel(execution.record.binding)}${status.detail ? ` · ${status.label}: ${status.detail}` : ""}`}
    >
      <button
        ref={buttonRef}
        type="button"
        className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_18px] items-center gap-x-3 gap-y-1 px-2 py-2 text-left transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        onClick={(event) => onToggle(event.currentTarget)}
        aria-expanded={expanded}
        aria-controls={`work-body-${execution.id}`}
        aria-label={accessibleName}
        data-testid={`work-summary-${execution.id}`}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`inline-flex items-center gap-2 text-[11px] font-semibold ${execution.record.status === "running" ? "text-signal-foreground" : STATUS_TONE_CLASS[statusTone]}`}>
              <StatusGlyph kind={visualKind} size={14} transition={statusTransition} />
              <span className="tabular-nums">{primaryLabel}</span>
            </span>
            {status.detail && execution.record.status !== "completed" && execution.record.status !== "running" && (
              <span className="text-[10px] font-medium text-text-tertiary">· {status.detail}</span>
            )}
          </span>
          <span className="mt-1 block min-w-0 whitespace-normal font-mono text-[9px] leading-4 text-text-tertiary">
            {metadata}
          </span>
        </span>
        <ChevronDown size={15} className={`text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "" : "-rotate-90"}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div
          id={`work-body-${execution.id}`}
          className="flex flex-col gap-4 border-t border-border-subtle px-1 py-4 sm:px-2"
          data-testid={`work-body-${execution.id}`}
        >
          <div
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-text-tertiary"
            data-testid={`work-binding-${execution.id}`}
            title={`${execution.record.binding.providerDisplayName} · ${selectionLabel(execution.record.binding.selection)}`}
          >
            <span className="font-medium text-text-secondary">
              {identity.displayName ?? identity.agentName} · {identity.profile}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{modelBindingLabel(execution.record.binding)}</span>
          </div>
          {timeline.map((entry) => entry.kind === "tool-run"
            ? (
              <div
                key={entry.id}
                className="conversation-part"
                data-conversation-part="tool"
              >
                <ToolRunCard
                  id={entry.id}
                  items={entry.items}
                  tools={entry.tools}
                  projectSlug={projectSlug}
                  sessionId={focusStoreSessionId}
                />
              </div>
            )
            : (
              <SessionMessageView
                key={entry.id}
                message={entry.message}
                parts={entry.parts}
                showMeta={entry.showMeta}
                identity={identity}
                projectSlug={projectSlug}
                focusStoreSessionId={focusStoreSessionId}
                childSessionLinks={execution.childSessionLinks}
                agents={agents}
                onInspectModelAudit={onInspectModelAudit}
              />
            ))}
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
        </div>
      )}
    </section>
  );
}

interface ExecutionTurnProps {
  execution: ExecutionWorkstreamExecution;
  expanded: boolean;
  identity: { agentName: string; displayName?: string; profile: ProfileName };
  projectSlug: string;
  focusStoreSessionId: string;
  agents: readonly AgentDescriptor[];
  onToggle: (executionId: string, button: HTMLButtonElement) => void;
  onButtonRef: (executionId: string, button: HTMLButtonElement | null) => void;
  onInspectModelAudit?: (messageId: string) => void;
  checkpoint?: SessionExecutionInputCheckpoint;
  continuationExecutionNumber?: number;
}

const ExecutionTurn = memo(function ExecutionTurn({
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
  onButtonRef,
}: ExecutionTurnProps) {
  executionTurnRenderObserverForTest?.(execution.id);

  return (
    <article className="flex min-w-0 flex-col gap-4" data-testid={`execution-turn-${execution.id}`}>
      {execution.userMessages.map((message) => (
        <MsgUser
          key={message.id}
          message={message}
          projectSlug={projectSlug}
          focusStoreSessionId={focusStoreSessionId}
          childSessionLinks={execution.childSessionLinks}
          agentDescriptors={agents}
          onInspectModelAudit={onInspectModelAudit}
        />
      ))}
      <WorkDisclosure
        execution={execution}
        expanded={expanded}
        identity={identity}
        projectSlug={projectSlug}
        focusStoreSessionId={focusStoreSessionId}
        agents={agents}
        checkpoint={checkpoint}
        continuationExecutionNumber={continuationExecutionNumber}
        onToggle={(button) => onToggle(execution.id, button)}
        onInspectModelAudit={onInspectModelAudit}
        buttonRef={(button) => onButtonRef(execution.id, button)}
      />
      {execution.finalResponse && (
        <FinalAgentResponse
          message={execution.finalResponse.message}
          textParts={execution.finalResponse.textParts}
          identity={identity}
        />
      )}
    </article>
  );
});

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
  const steps = useSessionStore(sessionId, (state) => state.steps, slug);
  const executionInputCheckpoints = useSessionStore(sessionId, (state) => state.executionInputCheckpoints ?? [], slug);
  const childSessionLinks = useSessionStore(sessionId, (state) => state.childSessionLinks, slug);
  const compression = useSessionStore(sessionId, (state) => state.compression, slug);
  const focusStoreSessionId = useSessionStore(sessionId, (state) => state.rootSessionId, slug);

  const previousProjectionRef = useRef<ExecutionWorkstreamProjection | undefined>(undefined);
  const projection = useMemo(() => stabilizeExecutionWorkstreamProjection(
    previousProjectionRef.current,
    buildExecutionWorkstream({
      messages,
      executions,
      steps,
      childSessionLinks,
      compression,
      session: sessionIdentity,
      agentDescriptors: agents,
    }),
  ), [
    agents,
    childSessionLinks,
    compression,
    executions,
    messages,
    steps,
    sessionIdentity.agentName,
    sessionIdentity.profile,
  ]);
  useLayoutEffect(() => {
    previousProjectionRef.current = projection;
  }, [projection]);
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
    () => {
      const snapshot = uiSnapshotRef.current;
      const initial = new Set(snapshot.expandedIds);
      for (const execution of projection.executions) {
        if (!snapshot.manualOverrideIds.has(execution.id)
          && !snapshot.statusByExecutionId.has(execution.id)
          && execution.record.status === "running") {
          initial.add(execution.id);
        }
      }
      return initial;
    },
  );
  const expandedIdsRef = useRef(expandedIds);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(uiSnapshotRef.current.nearBottom);
  const workButtonByExecutionIdRef = useRef(new Map<string, HTMLButtonElement>());
  const pendingDisclosureAnchorRef = useRef<{ executionId: string; viewportTop: number } | null>(null);
  const pendingAutoCollapseRef = useRef(false);

  useLayoutEffect(() => {
    const snapshot = uiSnapshotRef.current;
    const next = new Set(expandedIdsRef.current);
    let changed = false;
    const currentIds = new Set(projection.executions.map((execution) => execution.id));

    for (const id of next) {
      if (!currentIds.has(id)) {
        next.delete(id);
        changed = true;
      }
    }

    for (const execution of projection.executions) {
      const previousStatus = snapshot.statusByExecutionId.get(execution.id);
      const manuallyOverridden = snapshot.manualOverrideIds.has(execution.id);

      if (previousStatus === undefined && execution.record.status === "running" && !manuallyOverridden) {
        if (!next.has(execution.id)) {
          next.add(execution.id);
          changed = true;
        }
      } else if (
        previousStatus === "running"
        && execution.record.status === "completed"
        && nearBottomRef.current
        && !manuallyOverridden
        && next.has(execution.id)
      ) {
        next.delete(execution.id);
        pendingAutoCollapseRef.current = true;
        changed = true;
      }

      snapshot.statusByExecutionId.set(execution.id, execution.record.status);
    }

    for (const id of snapshot.statusByExecutionId.keys()) {
      if (!currentIds.has(id)) snapshot.statusByExecutionId.delete(id);
    }
    for (const id of snapshot.manualOverrideIds) {
      if (!currentIds.has(id)) snapshot.manualOverrideIds.delete(id);
    }

    if (changed) {
      snapshot.expandedIds = new Set(next);
      expandedIdsRef.current = next;
      setExpandedIds(next);
    } else {
      snapshot.expandedIds = new Set(expandedIdsRef.current);
    }
  }, [projection.executions]);

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
    const element = scrollerRef.current;
    if (!element) return;
    const pendingAnchor = pendingDisclosureAnchorRef.current;
    if (pendingAnchor) {
      const button = workButtonByExecutionIdRef.current.get(pendingAnchor.executionId);
      if (button) {
        const delta = button.getBoundingClientRect().top - pendingAnchor.viewportTop;
        if (Math.abs(delta) > 0.5) element.scrollTop += delta;
      }
      pendingDisclosureAnchorRef.current = null;
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      nearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
      const snapshot = uiSnapshotRef.current;
      snapshot.scrollTop = element.scrollTop;
      snapshot.nearBottom = nearBottomRef.current;
      snapshot.hasScrollPosition = true;
      return;
    }

    if (pendingAutoCollapseRef.current) {
      pendingAutoCollapseRef.current = false;
      if (nearBottomRef.current) element.scrollTop = element.scrollHeight;
      const snapshot = uiSnapshotRef.current;
      snapshot.scrollTop = element.scrollTop;
      snapshot.nearBottom = nearBottomRef.current;
      snapshot.hasScrollPosition = true;
      return;
    }

    if (!nearBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    const uiSnapshot = uiSnapshotRef.current;
    uiSnapshot.scrollTop = element.scrollTop;
    uiSnapshot.nearBottom = true;
    uiSnapshot.hasScrollPosition = true;
  }, [
    childSessionLinks,
    compression,
    executionInputCheckpoints,
    executions,
    expandedIds,
    messages,
    steps,
  ]);

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

  const toggleExecution = useCallback((executionId: string, button: HTMLButtonElement) => {
    pendingDisclosureAnchorRef.current = {
      executionId,
      viewportTop: button.getBoundingClientRect().top,
    };
    const next = new Set(expandedIdsRef.current);
    if (next.has(executionId)) next.delete(executionId);
    else next.add(executionId);
    const snapshot = uiSnapshotRef.current;
    snapshot.manualOverrideIds.add(executionId);
    snapshot.expandedIds = new Set(next);
    expandedIdsRef.current = next;
    setExpandedIds(next);
  }, []);

  const registerWorkButton = useCallback((
    executionId: string,
    button: HTMLButtonElement | null,
  ) => {
    if (button) workButtonByExecutionIdRef.current.set(executionId, button);
    else workButtonByExecutionIdRef.current.delete(executionId);
  }, []);

  const isEmpty = projection.items.length === 0 && projection.diagnostics.length === 0;

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="conversation-scroller min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden bg-bg-base"
      style={{ overflowAnchor: "none", scrollbarGutter: "stable" }}
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
                  <ExecutionTurn
                    key={`execution-${item.id}`}
                    execution={item}
                    expanded={expandedIds.has(item.id)}
                    identity={projection.session}
                    projectSlug={slug}
                    focusStoreSessionId={focusStoreSessionId}
                    agents={agents}
                    checkpoint={checkpoint}
                    continuationExecutionNumber={continuationExecutionNumber}
                    onToggle={toggleExecution}
                    onButtonRef={registerWorkButton}
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
