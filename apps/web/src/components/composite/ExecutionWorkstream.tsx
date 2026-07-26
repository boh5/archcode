import {
  memo,
  useCallback,
  useEffect,
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
import { presentExecutionStatus } from "../../lib/execution-status-presentation";
import { getToolSummary } from "../../lib/tool-format";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { ConversationRail } from "../primitives/ConversationRail";
import { RelativeTime, useElapsedTime } from "../primitives/TemporalText";
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
  onInspectModelAudit,
}: {
  message: SessionMessage;
  parts?: readonly SessionPart[];
  projectSlug?: string;
  focusStoreSessionId?: string;
  childSessionLinks?: readonly ToolChildSessionLink[];
  onInspectModelAudit?: (messageId: string) => void;
}) {
  const modelChanged = message.modelAudit?.reason === "config_invalidated";

  return (
    <div className="flex min-w-0 flex-col gap-2" data-message-kind="canonical-user">
      {parts.map((part) => {
        if (part.type === "text") {
          return (
            <div key={part.id} className="flex justify-end">
              <div className="max-w-[660px] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-bg-muted px-4 py-3.5 text-[15px] leading-[1.66] text-text-primary">
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
            />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-end gap-x-2 text-[12px] text-text-tertiary">
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
        <RelativeTime timestamp={message.createdAt} />
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
        <RelativeTime timestamp={part.compactedAt} className="ml-auto text-[11px] text-text-tertiary" />
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
}: {
  part: SessionPart;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
}) {
  switch (part.type) {
    case "text": {
      const interrupted = (part.meta as Record<string, unknown> | undefined)?.interrupted === true;
      return (
        <div className="max-w-[72ch] text-[13px] leading-[1.7] text-text-secondary">
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
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
}: {
  message: SessionMessage;
  parts?: readonly SessionPart[];
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
}) {
  return (
    <div className="w-full min-w-0" data-message-kind="agent">
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
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SessionMessageView({
  message,
  parts = message.parts,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  onInspectModelAudit,
}: {
  message: SessionMessage;
  parts?: readonly SessionPart[];
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
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
        onInspectModelAudit={onInspectModelAudit}
      />
    );
  }
  return (
    <MsgAgent
      message={message}
      parts={parts}
      projectSlug={projectSlug}
      focusStoreSessionId={focusStoreSessionId}
      childSessionLinks={childSessionLinks}
    />
  );
}

function currentExecutionActivity(execution: ExecutionWorkstreamExecution): string | undefined {
  const parts = execution.workMessages.flatMap((slice) => slice.parts);
  let latestActiveTool: Extract<SessionPart, { type: "tool" }> | undefined;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool") continue;
    if (part.state === "pending" || part.state === "running") {
      latestActiveTool = part;
      break;
    }
  }
  if (latestActiveTool === undefined) return undefined;
  const summary = getToolSummary(
    latestActiveTool.toolName,
    "input" in latestActiveTool ? latestActiveTool.input : undefined,
  );
  return summary.primary === "—"
    ? latestActiveTool.toolName
    : `${latestActiveTool.toolName} ${summary.primary}`;
}

function FinalAgentResponse({
  message,
  textParts,
}: {
  message: SessionMessage;
  textParts: readonly TextPart[];
}) {
  const text = textParts.map((part) => part.text).join("");

  return (
    <section
      className="w-full min-w-0"
      data-message-kind="agent"
      data-testid={`final-response-${message.executionId ?? message.id}`}
    >
      <div className="msg-parts">
        <div className="conversation-part" data-conversation-part="content">
          <MarkdownContent variant="response">{text}</MarkdownContent>
        </div>
      </div>
    </section>
  );
}

function WorkDisclosure({
  execution,
  expanded,
  projectSlug,
  focusStoreSessionId,
  onToggle,
  onInspectModelAudit,
  checkpoint,
  continuationExecutionNumber,
  buttonRef,
}: {
  execution: ExecutionWorkstreamExecution;
  expanded: boolean;
  projectSlug: string;
  focusStoreSessionId: string;
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
  const duration = useElapsedTime({
    startedAt: execution.record.startedAt,
    active: execution.record.status === "running",
    durationMs: execution.record.durationMs,
    endedAt: execution.record.endedAt,
  });
  const currentActivity = execution.record.status === "running"
    ? currentExecutionActivity(execution)
    : undefined;
  const primaryLabel = execution.record.status === "running"
    ? `Working · ${duration}`
    : execution.record.status === "completed"
      ? `Worked for ${duration}`
      : status.productStatus === "stopped" && status.detail
        ? `${status.label} · ${status.detail}`
        : status.label;
  const accessibleState = execution.record.status === "completed"
    ? "completed"
    : execution.record.status === "running"
      ? "running"
      : status.label.toLowerCase();
  const accessibleName = [
    `Execution ${execution.number}`,
    accessibleState,
    execution.record.status === "completed" ? `worked for ${duration}` : `elapsed ${duration}`,
    currentActivity,
    status.detail,
    continuationExecutionNumber === undefined
      ? undefined
      : `continued in Execution ${continuationExecutionNumber}`,
  ].filter(Boolean).join(", ");

  return (
    <section
      className="min-w-0"
      data-testid={`work-disclosure-${execution.id}`}
      data-work-expanded={expanded ? "true" : "false"}
      data-product-status={status.productStatus}
      title={status.detail ? `${status.label} · ${status.detail}` : status.label}
    >
      <button
        ref={buttonRef}
        type="button"
        className="work-summary-control flex min-h-8 max-w-full items-center gap-2 rounded-md py-1 pl-0 pr-1.5 text-left text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onClick={(event) => onToggle(event.currentTarget)}
        aria-expanded={expanded}
        aria-controls={`work-body-${execution.id}`}
        aria-label={accessibleName}
        data-testid={`work-summary-${execution.id}`}
      >
        <ChevronDown
          size={13}
          className={`shrink-0 text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
        {execution.record.status === "running" && (
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-signal" aria-hidden="true" />
        )}
        <strong className="shrink-0 text-[12px] font-semibold leading-4 text-inherit">
          <span className="tabular-nums">{primaryLabel}</span>
        </strong>
        {currentActivity && (
          <span className="min-w-0 truncate text-[12px] leading-4 text-text-tertiary">
            <span aria-hidden="true" className="mr-2 text-border-strong">—</span>
            {currentActivity}
          </span>
        )}
      </button>
      {expanded && (
        <div
          id={`work-body-${execution.id}`}
          className="flex w-full min-w-0 flex-col gap-2.5 pb-1 pl-5 pt-2"
          data-testid={`work-body-${execution.id}`}
        >
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
                projectSlug={projectSlug}
                focusStoreSessionId={focusStoreSessionId}
                childSessionLinks={execution.childSessionLinks}
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
  projectSlug: string;
  focusStoreSessionId: string;
  onToggle: (executionId: string, button: HTMLButtonElement) => void;
  onButtonRef: (executionId: string, button: HTMLButtonElement | null) => void;
  onInspectModelAudit?: (messageId: string) => void;
  checkpoint?: SessionExecutionInputCheckpoint;
  continuationExecutionNumber?: number;
}

const ExecutionTurn = memo(function ExecutionTurn({
  execution,
  expanded,
  projectSlug,
  focusStoreSessionId,
  onToggle,
  onInspectModelAudit,
  checkpoint,
  continuationExecutionNumber,
  onButtonRef,
}: ExecutionTurnProps) {
  executionTurnRenderObserverForTest?.(execution.id);

  return (
    <article className="flex min-w-0 flex-col gap-3" data-testid={`execution-turn-${execution.id}`}>
      {execution.userMessages.map((message) => (
        <MsgUser
          key={message.id}
          message={message}
          projectSlug={projectSlug}
          focusStoreSessionId={focusStoreSessionId}
          childSessionLinks={execution.childSessionLinks}
          onInspectModelAudit={onInspectModelAudit}
        />
      ))}
      <WorkDisclosure
        execution={execution}
        expanded={expanded}
        projectSlug={projectSlug}
        focusStoreSessionId={focusStoreSessionId}
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
        />
      )}
    </article>
  );
});

function DiagnosticBlock({
  diagnostic,
  projectSlug,
  focusStoreSessionId,
  onInspectModelAudit,
}: {
  diagnostic: ExecutionWorkstreamDiagnostic;
  projectSlug: string;
  focusStoreSessionId: string;
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
              projectSlug={projectSlug}
              focusStoreSessionId={focusStoreSessionId}
              childSessionLinks={[]}
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
                projectSlug={slug}
                focusStoreSessionId={focusStoreSessionId}
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
                    projectSlug={slug}
                    focusStoreSessionId={focusStoreSessionId}
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
                  />
                );
              }
              return (
                <section key={`activity-${item.id}`} className="border-l-2 border-warning px-3 py-2">
                  <SessionMessageView
                    message={item.message}
                    projectSlug={slug}
                    focusStoreSessionId={focusStoreSessionId}
                    childSessionLinks={[]}
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
