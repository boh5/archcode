import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { ChevronDown, CircleAlert, Info, TriangleAlert } from "lucide-react";
import {
  TOOL_DELEGATE,
  type AgentDescriptor,
  type AssistantOutputPart,
  type ProfileName,
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
  type ExecutionWorkstreamSegment,
  type ExecutionWorkstreamProjection,
  stabilizeExecutionWorkstreamProjection,
} from "../../lib/execution-workstream";
import { buildDelegationCardViewModel } from "../../lib/delegation-card-model";
import { buildToolRunTimeline } from "../../lib/tool-runs";
import { presentExecutionStatus } from "../../lib/execution-status-presentation";
import { getToolSummary } from "../../lib/tool-format";
import { MarkdownContent } from "../primitives/MarkdownContent";
import {
  ConversationRail,
  SessionThreadColumn,
  WORK_ACTIVITY_CHILD_LANE_CLASS,
  WORK_ACTIVITY_LANE_CLASS,
} from "../primitives/ConversationRail";
import { RelativeTime, useElapsedTime } from "../primitives/TemporalText";
import { AttachmentChip } from "../primitives/AttachmentChip";
import { CompressionBlock } from "./CompressionBlock";
import { DelegationCard } from "./DelegationCard";
import { ReasoningBlock, ReasoningUsageSummary } from "./ReasoningBlock";
import { RecoveryNotice } from "./RecoveryNotice";
import { ToolCard } from "./ToolCard";
import { ToolRunCard } from "./ToolRunCard";
import { ExecutionNavigationRail } from "../features/ExecutionNavigationRail";
import { ScrollToLatestButton } from "../features/ScrollToLatestButton";

const AT_BOTTOM_THRESHOLD_PX = 24;
const SHOW_JUMP_TO_LATEST_THRESHOLD_PX = 48;
const EXECUTION_NAVIGATION_MINIMUM_ITEMS = 4;
const EXECUTION_NAVIGATION_MINIMUM_GUTTER_PX = 32;
const EXECUTION_NAVIGATION_HITBOX_WIDTH_PX = 28;
const EXECUTION_NAVIGATION_MINIMUM_LEFT_PX = 4;
const EXECUTION_NAVIGATION_PREFERRED_LEFT_PX = 12;
const EXECUTION_READING_LINE_PX = 16;
const EXECUTION_NAVIGATION_SETTLE_MS = 120;
const TOUCH_MOMENTUM_IDLE_MS = 180;
const SESSION_SCROLLBAR_GUTTER_PROPERTY = "--session-scrollbar-gutter";

interface WorkstreamUiSnapshot {
  expandedIds: Set<string>;
  manualOverrideIds: Set<string>;
  statusByExecutionId: Map<string, SessionExecutionRecord["status"]>;
  scrollTop: number;
  followLatest: boolean;
  hasScrollPosition: boolean;
}

const workstreamUiBySession = new Map<string, WorkstreamUiSnapshot>();
const workstreamRouteLifecycleGeneration = new Map<string, number>();
let executionTurnRenderObserverForTest:
  ((executionId: string) => void) | undefined;

/** Test-only render isolation probe; production leaves it undefined. */
export function __setExecutionTurnRenderObserverForTest(
  observer: ((executionId: string) => void) | undefined,
): void {
  executionTurnRenderObserverForTest = observer;
}

function workstreamUiKey(
  slug: string,
  routeScopeId: string,
  sessionId: string,
): string {
  return `${slug}\u0000${routeScopeId}\u0000${sessionId}`;
}

function createWorkstreamUiSnapshot(): WorkstreamUiSnapshot {
  return {
    expandedIds: new Set(),
    manualOverrideIds: new Set(),
    statusByExecutionId: new Map(),
    scrollTop: 0,
    followLatest: true,
    hasScrollPosition: false,
  };
}

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(
    0,
    element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

function scrollElementTo(
  element: HTMLElement,
  top: number,
  behavior: ScrollBehavior = "auto",
): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top, behavior });
    return;
  }
  element.scrollTop = top;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select, [contenteditable='true']") ||
      target.closest(
        "[data-testid='session-composer-dock'], [data-inspector-surface]",
      ) !== null)
  );
}

function getWorkstreamUiSnapshot(
  slug: string,
  routeScopeId: string,
  sessionId: string,
): WorkstreamUiSnapshot {
  const key = workstreamUiKey(slug, routeScopeId, sessionId);
  const existing = workstreamUiBySession.get(key);
  if (existing) return existing;
  const created = createWorkstreamUiSnapshot();
  workstreamUiBySession.set(key, created);
  return created;
}

/** Route cleanup boundary: UI-only state never survives a Session route lifecycle. */
export function clearExecutionWorkstreamUiState(
  slug: string,
  routeScopeId?: string,
): void {
  const prefix =
    routeScopeId === undefined
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
  const generation =
    (workstreamRouteLifecycleGeneration.get(lifecycleKey) ?? 0) + 1;
  workstreamRouteLifecycleGeneration.set(lifecycleKey, generation);

  return () => {
    queueMicrotask(() => {
      if (workstreamRouteLifecycleGeneration.get(lifecycleKey) !== generation)
        return;
      workstreamRouteLifecycleGeneration.delete(lifecycleKey);
      clearExecutionWorkstreamUiState(slug, routeScopeId);
    });
  };
}

function selectionLabel(selection: {
  model: string;
  variant?: string;
}): string {
  return selection.variant
    ? `${selection.model} · ${selection.variant}`
    : selection.model;
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
    <div
      className="flex w-full min-w-0 flex-col gap-2"
      data-message-kind="canonical-user"
    >
      {parts.map((part) => {
        if (part.type === "text") {
          return (
            <div
              key={part.id}
              className="flex w-full justify-end"
              data-user-message-row=""
            >
              <div
                className="min-w-0 max-w-[660px] whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-border-subtle bg-bg-muted px-4 py-3.5 text-[15px] leading-[1.66] text-text-primary"
                data-user-message-surface=""
              >
                {part.text}
              </div>
            </div>
          );
        }
        if (part.type === "attachment") {
          return (
            <div key={part.id} className="flex w-full justify-end" data-user-message-row="attachment">
              <AttachmentChip attachment={part.attachment} />
            </div>
          );
        }
        return (
          <div
            key={part.id}
            className="conversation-part"
            data-conversation-part={part.type === "tool" ? "tool" : "content"}
          >
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
          <span
            className="text-warning"
            data-testid={`message-model-change-${message.id}`}
          >
            Model changed:{" "}
            {selectionLabel(message.modelAudit.requested.selection)} →{" "}
            {selectionLabel(message.modelAudit.actual)}
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

function CompactionBlock({
  part,
}: {
  part: Extract<SessionPart, { type: "compaction" }>;
}) {
  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle bg-transparent px-3 py-2">
        <Info
          size={12}
          className="shrink-0 text-text-muted"
          aria-hidden="true"
        />
        <span className="text-[11px] font-medium text-text-tertiary">
          Hard context compaction
        </span>
        <RelativeTime
          timestamp={part.compactedAt}
          className="ml-auto text-[11px] text-text-tertiary"
        />
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
      return (
        <div className="max-w-[72ch] text-[13px] leading-[1.7] text-text-secondary">
          <MarkdownContent isStreaming={!part.completedAt}>
            {part.text}
          </MarkdownContent>
        </div>
      );
    }
    case "assistant-output": {
      const interrupted =
        (part.meta as Record<string, unknown> | undefined)?.interrupted ===
        true;
      return (
        <div className="max-w-[72ch] text-[13px] leading-[1.7] text-text-secondary">
          {interrupted && <InterruptedBadge />}
          <MarkdownContent isStreaming={!part.completedAt}>
            {part.text}
          </MarkdownContent>
        </div>
      );
    }
    case "reasoning": {
      const interrupted =
        (part.meta as Record<string, unknown> | undefined)?.interrupted ===
        true;
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
      return (
        <ToolCard
          part={part}
          projectSlug={projectSlug}
          sessionId={focusStoreSessionId}
        />
      );
    case "system-notice":
      return <SystemNoticeBlock part={part} />;
    case "compaction":
      return <CompactionBlock part={part} />;
    case "recovery-notice":
      return <RecoveryNotice part={part} />;
    case "goal-notice":
      return null;
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
            <div
              key={entry.id}
              className="conversation-part"
              data-conversation-part={partKind}
            >
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

function currentExecutionActivity(
  segment: ExecutionWorkstreamSegment,
): string | undefined {
  const parts = segment.workItems.flatMap((item) =>
    item.kind === "message" ? item.parts : []
  );
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
  outputParts,
}: {
  message: SessionMessage;
  outputParts: readonly AssistantOutputPart[];
}) {
  return (
    <section
      className="w-full min-w-0"
      data-message-kind="agent"
      data-testid={`final-response-${message.executionId ?? message.id}`}
    >
      <div className="msg-parts">
        {outputParts.map((part) => (
          <div
            key={part.id}
            className="conversation-part"
            data-conversation-part="content"
          >
            <MarkdownContent variant="response">{part.text}</MarkdownContent>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkDisclosure({
  execution,
  segment,
  expanded,
  projectSlug,
  focusStoreSessionId,
  onToggle,
  onInspectModelAudit,
  buttonRef,
  current,
}: {
  execution: ExecutionWorkstreamExecution;
  segment: ExecutionWorkstreamSegment;
  expanded: boolean;
  projectSlug: string;
  focusStoreSessionId: string;
  onToggle: (button: HTMLButtonElement) => void;
  onInspectModelAudit?: (messageId: string) => void;
  buttonRef: (button: HTMLButtonElement | null) => void;
  current: boolean;
}) {
  const timeline = useMemo(
    () => buildToolRunTimeline(segment.workItems),
    [segment.workItems],
  );
  const status = presentExecutionStatus(execution.record);
  const active = current && execution.record.status === "running";
  const duration = useElapsedTime({
    startedAt: segment.windowStartedAt,
    active,
    durationMs: segment.activeDurationMs,
    ...(active ? { durationUpdatedAt: segment.windowEndedAt } : {}),
    endedAt: segment.windowEndedAt,
  });
  const currentActivity =
    active
      ? currentExecutionActivity(segment)
      : undefined;
  const primaryLabel =
    active
      ? `Working for ${duration}`
      : current && execution.record.status === "suspended"
        ? `${status.label} · Worked for ${duration}`
        : `Worked for ${duration}`;
  const accessibleState =
    active ? "running" : current && execution.record.status === "suspended"
      ? status.productStatus
      : "closed";
  const accessibleName = [
    "Work segment",
    accessibleState,
    `worked for ${duration}`,
    currentActivity,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <section
      className="w-full min-w-0"
      data-testid={`work-disclosure-${segment.id}`}
      data-work-expanded={expanded ? "true" : "false"}
      data-product-status={current ? status.productStatus : "completed"}
      title={
        status.detail ? `${status.label} · ${status.detail}` : status.label
      }
    >
      <button
        ref={buttonRef}
        type="button"
        className={`work-summary-control group relative flex min-h-8 cursor-pointer items-center gap-2 rounded-md py-1 pl-0 pr-1.5 text-left text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${WORK_ACTIVITY_LANE_CLASS}`}
        onClick={(event) => onToggle(event.currentTarget)}
        aria-expanded={expanded}
        aria-controls={`work-body-${segment.id}`}
        aria-label={accessibleName}
        data-testid={`work-summary-${segment.id}`}
      >
        <ChevronDown
          size={13}
          className={`absolute -left-4 top-1/2 shrink-0 -translate-y-1/2 text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
        <strong className="shrink-0 text-[13px] font-semibold leading-5 text-inherit">
          <span className="tabular-nums">{primaryLabel}</span>
        </strong>
        {active && (
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-signal"
            aria-hidden="true"
          />
        )}
        {currentActivity && (
          <span className="min-w-0 truncate text-[12px] leading-4 text-text-tertiary">
            <span aria-hidden="true" className="mr-2 text-border-strong">
              —
            </span>
            {currentActivity}
          </span>
        )}
        <span
          className="h-px min-w-6 flex-1 bg-border-subtle transition-colors duration-[var(--motion-hover)] group-hover:bg-border-default"
          data-testid={`work-divider-${segment.id}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div
          id={`work-body-${segment.id}`}
          className="ml-1 flex w-[calc(100%-4px)] min-w-0 flex-col gap-3 border-l border-border-subtle pb-2 pl-5 pt-2"
          data-testid={`work-body-${execution.id}`}
        >
          {timeline.map((entry) =>
            entry.kind === "tool-run" ? (
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
            ) : entry.kind === "reasoning-usage" ? (
              <ReasoningUsageSummary key={entry.id} tokens={entry.tokens} />
            ) : (
              <SessionMessageView
                key={entry.id}
                message={entry.message}
                parts={entry.parts}
                projectSlug={projectSlug}
                focusStoreSessionId={focusStoreSessionId}
                childSessionLinks={execution.childSessionLinks}
                onInspectModelAudit={onInspectModelAudit}
              />
            ),
          )}
          {segment === execution.segments.at(-1) &&
            status.productStatus === "stopped" &&
            status.detail && (
              <div
                className={`rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] text-text-secondary ${WORK_ACTIVITY_CHILD_LANE_CLASS}`}
                data-testid={`execution-stop-detail-${segment.id}`}
              >
                <span className="font-medium">
                  Stop reason · {status.detail}
                </span>
                {execution.record.error && (
                  <span className="mt-1 block text-error">
                    {execution.record.error}
                  </span>
                )}
              </div>
            )}
        </div>
      )}
    </section>
  );
}

interface ExecutionTurnProps {
  execution: ExecutionWorkstreamExecution;
  expandedIds: ReadonlySet<string>;
  projectSlug: string;
  focusStoreSessionId: string;
  onToggle: (segmentId: string, button: HTMLButtonElement) => void;
  onButtonRef: (segmentId: string, button: HTMLButtonElement | null) => void;
  onArticleRef: (segmentId: string, article: HTMLElement | null) => void;
  onInspectModelAudit?: (messageId: string) => void;
  focusClientRequestId?: string | null;
}

const ExecutionTurn = memo(function ExecutionTurn({
  execution,
  expandedIds,
  projectSlug,
  focusStoreSessionId,
  onToggle,
  onInspectModelAudit,
  onButtonRef,
  onArticleRef,
  focusClientRequestId,
}: ExecutionTurnProps) {
  executionTurnRenderObserverForTest?.(execution.id);

  return (
    <article
      className="flex min-w-0 scroll-mt-4 flex-col gap-3"
      data-testid={`execution-turn-${execution.id}`}
    >
      {execution.segments.map((segment, index) => (
        <section
          key={segment.id}
          ref={(section) => onArticleRef(segment.id, section)}
          className={`flex min-w-0 scroll-mt-4 flex-col gap-3 ${segment.inputMessage?.clientRequestId === focusClientRequestId ? "rounded-md ring-2 ring-brand ring-offset-2 ring-offset-bg-base" : ""}`}
          data-client-request-id={segment.inputMessage?.clientRequestId}
          data-execution-navigation-target={segment.id}
          data-work-segment={segment.id}
          tabIndex={segment.inputMessage?.clientRequestId === focusClientRequestId ? -1 : undefined}
        >
          {segment.inputMessage && (
            <MsgUser
              message={segment.inputMessage}
              projectSlug={projectSlug}
              focusStoreSessionId={focusStoreSessionId}
              childSessionLinks={execution.childSessionLinks}
              onInspectModelAudit={onInspectModelAudit}
            />
          )}
          <WorkDisclosure
            execution={execution}
            segment={segment}
            expanded={expandedIds.has(segment.id)}
            projectSlug={projectSlug}
            focusStoreSessionId={focusStoreSessionId}
            onToggle={(button) => onToggle(segment.id, button)}
            onInspectModelAudit={onInspectModelAudit}
            buttonRef={(button) => onButtonRef(segment.id, button)}
            current={index === execution.segments.length - 1}
          />
          {segment.finalResponse && (
            <FinalAgentResponse
              message={segment.finalResponse.message}
              outputParts={segment.finalResponse.outputParts}
            />
          )}
        </section>
      ))}
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
  const messages =
    diagnostic.code === "duplicate_execution"
      ? diagnostic.messages
      : [diagnostic.message];
  const title =
    diagnostic.code === "orphan_message"
      ? "Message is missing an Execution reference"
      : diagnostic.code === "unknown_execution"
        ? `Message references unknown Execution ${diagnostic.executionId}`
        : `Duplicate Execution id ${diagnostic.executionId}`;

  return (
    <section
      className="overflow-hidden rounded-md border border-error/40 bg-error-muted"
      data-testid={`workstream-diagnostic-${diagnostic.code}`}
    >
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
  focusClientRequestId?: string | null;
}

export function ExecutionWorkstream({
  slug,
  sessionId,
  routeScopeId = sessionId,
  sessionIdentity,
  agents,
  onInspectModelAudit,
  focusClientRequestId,
}: ExecutionWorkstreamProps) {
  const messages = useSessionStore(sessionId, (state) => state.messages, slug);
  const executions = useSessionStore(
    sessionId,
    (state) => state.executions,
    slug,
  );
  const steps = useSessionStore(sessionId, (state) => state.steps, slug);
  const childSessionLinks = useSessionStore(
    sessionId,
    (state) => state.childSessionLinks,
    slug,
  );
  const compression = useSessionStore(
    sessionId,
    (state) => state.compression,
    slug,
  );
  const focusStoreSessionId = useSessionStore(
    sessionId,
    (state) => state.rootSessionId,
    slug,
  );
  const isRunning = useSessionStore(sessionId, (state) => state.isRunning, slug);

  const previousProjectionRef = useRef<
    ExecutionWorkstreamProjection | undefined
  >(undefined);
  const projection = useMemo(
    () =>
      stabilizeExecutionWorkstreamProjection(
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
      ),
    [
      agents,
      childSessionLinks,
      compression,
      executions,
      messages,
      steps,
      sessionIdentity.agentName,
      sessionIdentity.profile,
    ],
  );
  useLayoutEffect(() => {
    previousProjectionRef.current = projection;
  }, [projection]);
  const segments = useMemo(
    () => projection.executions.flatMap((execution) => execution.segments),
    [projection.executions],
  );
  const focusedSegmentId = useMemo(
    () => focusClientRequestId === null || focusClientRequestId === undefined
      ? undefined
      : segments.find((segment) => segment.inputMessage?.clientRequestId === focusClientRequestId)?.id,
    [focusClientRequestId, segments],
  );

  const uiSnapshotRef = useRef(
    getWorkstreamUiSnapshot(slug, routeScopeId, sessionId),
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const snapshot = uiSnapshotRef.current;
    const initial = new Set(snapshot.expandedIds);
    for (const execution of projection.executions) {
      const segment = execution.segments.at(-1);
      if (
        segment &&
        !snapshot.manualOverrideIds.has(segment.id) &&
        execution.record.status === "running"
      ) {
        initial.add(segment.id);
      }
    }
    return initial;
  });
  const expandedIdsRef = useRef(expandedIds);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(uiSnapshotRef.current.followLatest);
  const lastScrollTopRef = useRef(uiSnapshotRef.current.scrollTop);
  const pointerScrollingRef = useRef(false);
  const touchYRef = useRef<number | null>(null);
  const touchMomentumDirectionRef = useRef<"up" | "down" | null>(null);
  const touchMomentumTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const inputDirectionRef = useRef<"up" | "down" | null>(null);
  const inputDirectionClearFrameRef = useRef<number | null>(null);
  const inputDirectionGenerationRef = useRef(0);
  const jumpingToBottomRef = useRef(false);
  const navigationFrameRef = useRef<number | null>(null);
  const navigationSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const executionNavigationTargetRef = useRef<{
    executionId: string;
    targetTop: number;
  } | null>(null);
  const workButtonByExecutionIdRef = useRef(
    new Map<string, HTMLButtonElement>(),
  );
  const articleByExecutionIdRef = useRef(new Map<string, HTMLElement>());
  const pendingDisclosureAnchorRef = useRef<{
    executionId: string;
    viewportTop: number;
  } | null>(null);
  const pendingAutoCollapseRef = useRef(false);
  const [jumpToLatestVisible, setJumpToLatestVisible] = useState(false);
  const [currentSegmentId, setCurrentSegmentId] = useState<string | null>(
    segments[0]?.id ?? null,
  );
  const [navigationLayout, setNavigationLayout] = useState({
    visible: false,
    left: 0,
  });

  const setFollowLatest = useCallback((followLatest: boolean) => {
    followLatestRef.current = followLatest;
    uiSnapshotRef.current.followLatest = followLatest;
    if (followLatest) setJumpToLatestVisible(false);
  }, []);

  const clearPendingInputDirection = useCallback(() => {
    inputDirectionGenerationRef.current += 1;
    if (inputDirectionClearFrameRef.current !== null) {
      cancelAnimationFrame(inputDirectionClearFrameRef.current);
      inputDirectionClearFrameRef.current = null;
    }
    inputDirectionRef.current = null;
  }, []);

  const markInputDirection = useCallback(
    (direction: "up" | "down") => {
      clearPendingInputDirection();
      inputDirectionRef.current = direction;
      const generation = inputDirectionGenerationRef.current;
      inputDirectionClearFrameRef.current = requestAnimationFrame(() => {
        if (inputDirectionGenerationRef.current !== generation) return;
        inputDirectionClearFrameRef.current = null;
        inputDirectionRef.current = null;
      });
    },
    [clearPendingInputDirection],
  );

  const clearTouchMomentum = useCallback(() => {
    if (touchMomentumTimerRef.current !== null) {
      clearTimeout(touchMomentumTimerRef.current);
      touchMomentumTimerRef.current = null;
    }
    touchMomentumDirectionRef.current = null;
  }, []);

  const scheduleTouchMomentumClear = useCallback(() => {
    if (touchMomentumTimerRef.current !== null) {
      clearTimeout(touchMomentumTimerRef.current);
    }
    touchMomentumTimerRef.current = setTimeout(() => {
      touchMomentumTimerRef.current = null;
      touchMomentumDirectionRef.current = null;
    }, TOUCH_MOMENTUM_IDLE_MS);
  }, []);

  const syncScrollGeometry = useCallback((element: HTMLElement) => {
    const distance = distanceFromBottom(element);
    const atBottom = distance <= AT_BOTTOM_THRESHOLD_PX;
    const snapshot = uiSnapshotRef.current;
    snapshot.scrollTop = element.scrollTop;
    snapshot.hasScrollPosition = true;
    setJumpToLatestVisible((visible) => {
      if (followLatestRef.current || atBottom) return false;
      if (distance > SHOW_JUMP_TO_LATEST_THRESHOLD_PX) return true;
      return visible;
    });
    return { atBottom, distance };
  }, []);

  const syncExecutionNavigation = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const readingLine = scrollerRect.top + EXECUTION_READING_LINE_PX;
    const atBottom = distanceFromBottom(scroller) <= AT_BOTTOM_THRESHOLD_PX;
    const pendingNavigation = executionNavigationTargetRef.current;
    const pendingExecutionExists = pendingNavigation
      ? segments.some((segment) => segment.id === pendingNavigation.executionId)
      : false;
    const pendingTargetTop =
      pendingNavigation && pendingExecutionExists
        ? Math.min(
            Math.max(0, pendingNavigation.targetTop),
            Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          )
        : null;
    if (
      pendingNavigation &&
      (!pendingExecutionExists ||
        (pendingTargetTop !== null &&
          Math.abs(scroller.scrollTop - pendingTargetTop) <= 1))
    ) {
      executionNavigationTargetRef.current = null;
    }
    let low = 0;
    let high = segments.length - 1;
    let currentIndex = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const segment = segments[middle];
      if (!segment) break;
      const article = articleByExecutionIdRef.current.get(segment.id);
      if (!article) {
        currentIndex = -1;
        break;
      }
      if (article.getBoundingClientRect().top <= readingLine) {
        currentIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const current =
      pendingNavigation && pendingExecutionExists
        ? pendingNavigation.executionId
        : atBottom
          ? (segments.at(-1)?.id ?? null)
          : currentIndex >= 0
            ? (segments[currentIndex]?.id ?? null)
            : (segments[0]?.id ?? null);
    const fallback = segments[0]?.id ?? null;
    setCurrentSegmentId((previous) => {
      const next = current ?? fallback;
      return previous === next ? previous : next;
    });

    const thread = scroller.querySelector<HTMLElement>(
      "[data-session-thread-column]",
    );
    const finePointer =
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(pointer: fine)").matches;
    const gutter = thread
      ? thread.getBoundingClientRect().left - scrollerRect.left
      : 0;
    const visible =
      segments.length >= EXECUTION_NAVIGATION_MINIMUM_ITEMS &&
      scroller.scrollHeight > scroller.clientHeight + 1 &&
      gutter >= EXECUTION_NAVIGATION_MINIMUM_GUTTER_PX &&
      finePointer;
    const left = Math.max(
      EXECUTION_NAVIGATION_MINIMUM_LEFT_PX,
      Math.min(
        EXECUTION_NAVIGATION_PREFERRED_LEFT_PX,
        gutter - EXECUTION_NAVIGATION_HITBOX_WIDTH_PX,
      ),
    );
    setNavigationLayout((previous) =>
      previous.visible === visible && previous.left === left
        ? previous
        : { visible, left },
    );
  }, [segments]);

  const scheduleExecutionNavigationSync = useCallback(() => {
    if (navigationFrameRef.current !== null) return;
    navigationFrameRef.current = requestAnimationFrame(() => {
      navigationFrameRef.current = null;
      syncExecutionNavigation();
    });
  }, [syncExecutionNavigation]);

  const scheduleExecutionNavigationSettle = useCallback(() => {
    if (navigationSettleTimerRef.current !== null) {
      clearTimeout(navigationSettleTimerRef.current);
    }
    navigationSettleTimerRef.current = setTimeout(() => {
      navigationSettleTimerRef.current = null;
      executionNavigationTargetRef.current = null;
      syncExecutionNavigation();
    }, EXECUTION_NAVIGATION_SETTLE_MS);
  }, [syncExecutionNavigation]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    const transcriptSurface =
      element?.closest<HTMLElement>("[data-session-transcript-surface]") ??
      element?.parentElement;
    if (!element || !transcriptSurface) return;

    const syncScrollbarGutter = () => {
      const symmetricGutter = Math.max(
        0,
        (element.offsetWidth - element.clientWidth) / 2,
      );
      transcriptSurface.style.setProperty(
        SESSION_SCROLLBAR_GUTTER_PROPERTY,
        `${symmetricGutter}px`,
      );
      syncExecutionNavigation();
    };
    syncScrollbarGutter();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(syncScrollbarGutter);
    resizeObserver?.observe(element);

    return () => {
      resizeObserver?.disconnect();
      transcriptSurface.style.removeProperty(SESSION_SCROLLBAR_GUTTER_PROPERTY);
    };
  }, [syncExecutionNavigation]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const thread = scroller?.querySelector<HTMLElement>(
      "[data-session-thread-column]",
    );
    if (!scroller) return;
    syncExecutionNavigation();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncExecutionNavigation);
    observer.observe(scroller);
    if (thread) observer.observe(thread);
    return () => observer.disconnect();
  }, [segments, syncExecutionNavigation]);

  useEffect(
    () => () => {
      if (navigationFrameRef.current !== null)
        cancelAnimationFrame(navigationFrameRef.current);
      if (navigationSettleTimerRef.current !== null) {
        clearTimeout(navigationSettleTimerRef.current);
      }
      clearPendingInputDirection();
      clearTouchMomentum();
    },
    [clearPendingInputDirection, clearTouchMomentum],
  );

  useLayoutEffect(() => {
    const snapshot = uiSnapshotRef.current;
    const next = new Set(expandedIdsRef.current);
    let changed = false;
    const currentIds = new Set(segments.map((segment) => segment.id));
    const currentExecutionIds = new Set(
      projection.executions.map((execution) => execution.id),
    );

    for (const id of next) {
      if (!currentIds.has(id)) {
        next.delete(id);
        changed = true;
      }
    }

    for (const execution of projection.executions) {
      const segment = execution.segments.at(-1);
      if (!segment) continue;
      const previousStatus = snapshot.statusByExecutionId.get(execution.id);
      const manuallyOverridden = snapshot.manualOverrideIds.has(segment.id);

      if (
        execution.record.status === "running" &&
        !manuallyOverridden
      ) {
        if (!next.has(segment.id)) {
          next.add(segment.id);
          changed = true;
        }
      } else if (
        previousStatus === "running" &&
        execution.record.status === "completed" &&
        segment.finalResponse !== undefined &&
        followLatestRef.current &&
        !manuallyOverridden &&
        next.has(segment.id)
      ) {
        next.delete(segment.id);
        pendingAutoCollapseRef.current = true;
        changed = true;
      }

      snapshot.statusByExecutionId.set(execution.id, execution.record.status);
    }

    for (const id of snapshot.statusByExecutionId.keys()) {
      if (!currentExecutionIds.has(id)) snapshot.statusByExecutionId.delete(id);
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
  }, [projection.executions, segments]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    const uiSnapshot = uiSnapshotRef.current;
    if (!element) return;

    if (uiSnapshot.hasScrollPosition) {
      followLatestRef.current = uiSnapshot.followLatest;
      element.scrollTop = uiSnapshot.followLatest
        ? element.scrollHeight
        : uiSnapshot.scrollTop;
    } else {
      element.scrollTop = element.scrollHeight;
      followLatestRef.current = true;
    }
    lastScrollTopRef.current = element.scrollTop;
    syncScrollGeometry(element);
    syncExecutionNavigation();

    return () => {
      uiSnapshot.scrollTop = element.scrollTop;
      uiSnapshot.followLatest = followLatestRef.current;
      uiSnapshot.hasScrollPosition = true;
      uiSnapshot.expandedIds = new Set(expandedIdsRef.current);
    };
  }, [syncExecutionNavigation, syncScrollGeometry]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const pendingAnchor = pendingDisclosureAnchorRef.current;
    if (pendingAnchor) {
      const button = workButtonByExecutionIdRef.current.get(
        pendingAnchor.executionId,
      );
      if (button) {
        const delta =
          button.getBoundingClientRect().top - pendingAnchor.viewportTop;
        if (Math.abs(delta) > 0.5) element.scrollTop += delta;
      }
      pendingDisclosureAnchorRef.current = null;
      const { atBottom } = syncScrollGeometry(element);
      setFollowLatest(atBottom);
      const snapshot = uiSnapshotRef.current;
      snapshot.scrollTop = element.scrollTop;
      snapshot.hasScrollPosition = true;
      lastScrollTopRef.current = element.scrollTop;
      scheduleExecutionNavigationSync();
      return;
    }

    if (pendingAutoCollapseRef.current) {
      pendingAutoCollapseRef.current = false;
      if (followLatestRef.current) element.scrollTop = element.scrollHeight;
      const snapshot = uiSnapshotRef.current;
      snapshot.scrollTop = element.scrollTop;
      snapshot.hasScrollPosition = true;
      lastScrollTopRef.current = element.scrollTop;
      syncScrollGeometry(element);
      scheduleExecutionNavigationSync();
      return;
    }

    if (!followLatestRef.current) {
      syncScrollGeometry(element);
      scheduleExecutionNavigationSync();
      return;
    }
    element.scrollTop = element.scrollHeight;
    const uiSnapshot = uiSnapshotRef.current;
    uiSnapshot.scrollTop = element.scrollTop;
    uiSnapshot.followLatest = true;
    uiSnapshot.hasScrollPosition = true;
    lastScrollTopRef.current = element.scrollTop;
    syncScrollGeometry(element);
    scheduleExecutionNavigationSync();
  }, [
    childSessionLinks,
    compression,
    executions,
    expandedIds,
    messages,
    steps,
    scheduleExecutionNavigationSync,
    setFollowLatest,
    syncScrollGeometry,
  ]);

  const handleScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const previousScrollTop = lastScrollTopRef.current;
    const { atBottom } = syncScrollGeometry(element);
    const direction =
      inputDirectionRef.current ??
      (pointerScrollingRef.current
        ? element.scrollTop < previousScrollTop
          ? "up"
          : "down"
        : touchMomentumDirectionRef.current);
    clearPendingInputDirection();
    if (direction === "up") {
      if (jumpingToBottomRef.current) {
        jumpingToBottomRef.current = false;
        scrollElementTo(element, element.scrollTop);
      }
      setFollowLatest(false);
    } else if (direction === "down" && atBottom) {
      jumpingToBottomRef.current = false;
      clearTouchMomentum();
      setFollowLatest(true);
    } else if (jumpingToBottomRef.current && atBottom) {
      jumpingToBottomRef.current = false;
    }
    if (
      touchYRef.current === null &&
      touchMomentumDirectionRef.current !== null
    ) {
      scheduleTouchMomentumClear();
    }
    lastScrollTopRef.current = element.scrollTop;
    scheduleExecutionNavigationSync();
    scheduleExecutionNavigationSettle();
  }, [
    clearPendingInputDirection,
    clearTouchMomentum,
    scheduleExecutionNavigationSettle,
    scheduleExecutionNavigationSync,
    scheduleTouchMomentumClear,
    setFollowLatest,
    syncScrollGeometry,
  ]);

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (event.deltaY === 0) return;
      executionNavigationTargetRef.current = null;
      clearTouchMomentum();
      markInputDirection(event.deltaY < 0 ? "up" : "down");
      if (event.deltaY < 0) {
        if (jumpingToBottomRef.current && scrollerRef.current) {
          jumpingToBottomRef.current = false;
          scrollElementTo(scrollerRef.current, scrollerRef.current.scrollTop);
        }
        setFollowLatest(false);
      }
    },
    [clearTouchMomentum, markInputDirection, setFollowLatest],
  );

  const handlePointerDown = useCallback(() => {
    executionNavigationTargetRef.current = null;
    clearTouchMomentum();
    pointerScrollingRef.current = true;
    lastScrollTopRef.current = scrollerRef.current?.scrollTop ?? 0;
  }, [clearTouchMomentum]);

  const handlePointerEnd = useCallback(() => {
    pointerScrollingRef.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [handlePointerEnd]);

  const handleTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      executionNavigationTargetRef.current = null;
      clearTouchMomentum();
      touchYRef.current = event.touches[0]?.clientY ?? null;
    },
    [clearTouchMomentum],
  );

  const handleTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const previousY = touchYRef.current;
      const nextY = event.touches[0]?.clientY;
      if (previousY === null || nextY === undefined || nextY === previousY)
        return;
      const direction = nextY > previousY ? "up" : "down";
      markInputDirection(direction);
      touchMomentumDirectionRef.current = direction;
      touchYRef.current = nextY;
      if (direction === "up") setFollowLatest(false);
    },
    [markInputDirection, setFollowLatest],
  );

  const handleTouchEnd = useCallback(() => {
    touchYRef.current = null;
    if (touchMomentumDirectionRef.current !== null)
      scheduleTouchMomentumClear();
  }, [scheduleTouchMomentumClear]);

  const navigateRelativeExecution = useCallback(
    (direction: -1 | 1) => {
      const index = segments.findIndex(
        (segment) => segment.id === currentSegmentId,
      );
      const next =
        segments[
          Math.min(
            segments.length - 1,
            Math.max(0, (index < 0 ? 0 : index) + direction),
          )
        ];
      if (!next) return;
      const element = scrollerRef.current;
      const article = articleByExecutionIdRef.current.get(next.id);
      if (!element || !article) return;
      clearPendingInputDirection();
      clearTouchMomentum();
      jumpingToBottomRef.current = false;
      setFollowLatest(false);
      const targetTop =
        article.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        element.scrollTop -
        EXECUTION_READING_LINE_PX;
      executionNavigationTargetRef.current = {
        executionId: next.id,
        targetTop,
      };
      scrollElementTo(
        element,
        targetTop,
        prefersReducedMotion() ? "auto" : "smooth",
      );
      setCurrentSegmentId(next.id);
    },
    [
      clearPendingInputDirection,
      clearTouchMomentum,
      currentSegmentId,
      segments,
      setFollowLatest,
    ],
  );

  const handleScrollerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      if (
        event.altKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        navigateRelativeExecution(event.key === "ArrowUp" ? -1 : 1);
        return;
      }
      executionNavigationTargetRef.current = null;
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        clearTouchMomentum();
        markInputDirection("up");
        setFollowLatest(false);
      } else if (
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        event.key === "End" ||
        (event.key === " " && !event.shiftKey)
      ) {
        clearTouchMomentum();
        markInputDirection("down");
      }
    },
    [
      clearTouchMomentum,
      markInputDirection,
      navigateRelativeExecution,
      setFollowLatest,
    ],
  );

  const toggleExecution = useCallback(
    (executionId: string, button: HTMLButtonElement) => {
      // A disclosure click is a reading action. Suspend follow immediately so a
      // stream update batched with the expansion cannot pin before the anchor is
      // restored; the layout effect resumes follow only if the anchor lands at
      // the actual bottom.
      const element = scrollerRef.current;
      if (jumpingToBottomRef.current && element) {
        scrollElementTo(element, element.scrollTop);
      }
      jumpingToBottomRef.current = false;
      executionNavigationTargetRef.current = null;
      clearPendingInputDirection();
      clearTouchMomentum();
      setFollowLatest(false);
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
    },
    [clearPendingInputDirection, clearTouchMomentum, setFollowLatest],
  );

  const registerWorkButton = useCallback(
    (executionId: string, button: HTMLButtonElement | null) => {
      if (button) workButtonByExecutionIdRef.current.set(executionId, button);
      else workButtonByExecutionIdRef.current.delete(executionId);
    },
    [],
  );

  const registerExecutionArticle = useCallback(
    (executionId: string, article: HTMLElement | null) => {
      if (article) articleByExecutionIdRef.current.set(executionId, article);
      else articleByExecutionIdRef.current.delete(executionId);
    },
    [],
  );

  const jumpToLatest = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    clearPendingInputDirection();
    clearTouchMomentum();
    executionNavigationTargetRef.current = null;
    setFollowLatest(true);
    const hasRunningExecution = projection.executions.some(
      (execution) => execution.record.status === "running",
    );
    const behavior =
      hasRunningExecution || prefersReducedMotion() ? "auto" : "smooth";
    jumpingToBottomRef.current = behavior === "smooth";
    scrollElementTo(element, element.scrollHeight, behavior);
    if (behavior === "auto") {
      lastScrollTopRef.current = element.scrollTop;
      syncScrollGeometry(element);
      scheduleExecutionNavigationSync();
    }
    element.focus({ preventScroll: true });
  }, [
    clearPendingInputDirection,
    clearTouchMomentum,
    projection.executions,
    scheduleExecutionNavigationSync,
    setFollowLatest,
    syncScrollGeometry,
  ]);

  const jumpToExecution = useCallback(
    (executionId: string, behavior: ScrollBehavior) => {
      const element = scrollerRef.current;
      const article = articleByExecutionIdRef.current.get(executionId);
      if (!element || !article) return;
      clearPendingInputDirection();
      clearTouchMomentum();
      jumpingToBottomRef.current = false;
      setFollowLatest(false);
      const targetTop =
        article.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        element.scrollTop -
        EXECUTION_READING_LINE_PX;
      executionNavigationTargetRef.current = { executionId, targetTop };
      scrollElementTo(
        element,
        targetTop,
        prefersReducedMotion() ? "auto" : behavior,
      );
      setCurrentSegmentId(executionId);
    },
    [clearPendingInputDirection, clearTouchMomentum, setFollowLatest],
  );

  const appliedClientRequestFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusClientRequestId === null || focusClientRequestId === undefined || focusedSegmentId === undefined) return;
    const focusKey = `${focusClientRequestId}\u0000${focusedSegmentId}`;
    if (appliedClientRequestFocusRef.current === focusKey) return;
    const target = articleByExecutionIdRef.current.get(focusedSegmentId);
    if (!target) return;
    appliedClientRequestFocusRef.current = focusKey;
    jumpToExecution(focusedSegmentId, "auto");
    target.focus({ preventScroll: true });
  }, [focusClientRequestId, focusedSegmentId, jumpToExecution]);

  const isEmpty =
    projection.items.length === 0 && projection.diagnostics.length === 0;

  return (
    <div
      className="relative min-h-0 w-full flex-1 overflow-hidden bg-bg-base"
      data-testid="execution-workstream-viewport"
    >
      <div
        ref={scrollerRef}
        onKeyDown={handleScrollerKeyDown}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerEnd}
        onScroll={handleScroll}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        onWheel={handleWheel}
        className="conversation-scroller h-full min-h-0 w-full overflow-y-auto overflow-x-hidden bg-bg-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        style={{ overflowAnchor: "none", scrollbarGutter: "stable both-edges" }}
        data-testid="execution-workstream-scroller"
        role="region"
        aria-label="Session conversation"
        tabIndex={0}
      >
        <ConversationRail
          className="conversation-surface flex min-h-full py-9 max-[639px]:py-6"
          data-testid="execution-workstream-rail"
        >
          <SessionThreadColumn
            className={`flex min-h-full flex-1 flex-col ${isEmpty ? "items-center justify-center" : "gap-6"}`}
            data-testid="execution-thread-column"
          >
            {isEmpty ? (
              <div className="text-sm text-text-tertiary">
                No executions yet
              </div>
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
                    return (
                      <ExecutionTurn
                        key={`execution-${item.id}`}
                        execution={item}
                        expandedIds={expandedIds}
                        projectSlug={slug}
                        focusStoreSessionId={focusStoreSessionId}
                        onToggle={toggleExecution}
                        onButtonRef={registerWorkButton}
                        onArticleRef={registerExecutionArticle}
                        onInspectModelAudit={onInspectModelAudit}
                        focusClientRequestId={focusClientRequestId}
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
                    <section
                      key={`activity-${item.id}`}
                      className="border-l-2 border-warning px-3 py-2"
                    >
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
          </SessionThreadColumn>
        </ConversationRail>
      </div>
      <ExecutionNavigationRail
        segments={segments}
        currentSegmentId={currentSegmentId}
        running={isRunning}
        left={navigationLayout.left}
        visible={navigationLayout.visible}
        onNavigate={jumpToExecution}
      />
      {jumpToLatestVisible && <ScrollToLatestButton onClick={jumpToLatest} />}
    </div>
  );
}
