import { useCallback, useEffect, useRef, useState } from "react";
import { User, Ellipsis, ChevronRight, Sparkles, Info, TriangleAlert } from "lucide-react";
import { getWebSessionStore, useSessionStore } from "../../store/session-store";
import { useSessionFamilySteerTargetExecutionId } from "../../store/session-runtime-store";
import { useDeletePendingMessage, useEditPendingMessage, usePostMessage, useSteerPendingMessage } from "../../api/mutations";
import { ApiError } from "../../api/client";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { ToolCard } from "./ToolCard";
import { DelegationCard } from "./DelegationCard";
import { CompressionBlock } from "./CompressionBlock";
import {
  resolveAgentAppearance,
  resolveAgentDisplayName,
} from "../../lib/agent-constants";
import { buildDelegationCardViewModel } from "../../lib/delegation-card-model";
import type {
  AgentDescriptor,
  SessionMessage,
  PendingSessionMessage,
  SessionPart,
  SystemNoticePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolChildSessionLink,
  CompressionBlockPart,
} from "@archcode/protocol";
import { TOOL_DELEGATE } from "@archcode/protocol";
import { RecoveryNotice } from "./RecoveryNotice";
import { GroupedToolCard } from "./GroupedToolCard";
import { groupReadOnlyToolParts } from "../../lib/group-tools";
import { formatRelativeTime } from "../../lib/time-format";

function ReasoningBlock({ part }: { part: ReasoningPart }) {
  const [expanded, setExpanded] = useState(false);
  const streaming = !part.completedAt;

  return (
    <div className="bg-bg-overlay border border-border-subtle rounded-md overflow-hidden mb-2 shrink-0">
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-tertiary cursor-pointer select-none hover:bg-bg-hover w-full text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
        <Sparkles size={12} className="text-text-muted" />
        <span>{streaming ? "Thinking…" : "Reasoning"}</span>
        {streaming && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-dot" />}
      </button>
      {expanded && (
        <div className="px-2.5 pb-2 text-[12.5px] text-text-secondary italic leading-relaxed border-t border-border-subtle">
          <MarkdownContent isStreaming={streaming}>{part.text}</MarkdownContent>
        </div>
      )}
    </div>
  );
}

export function MsgUser({ message }: { message: SessionMessage }) {
  const textParts = message.parts.filter((p): p is TextPart => p.type === "text");
  const systemNoticeParts = message.parts.filter((p): p is SystemNoticePart => p.type === "system-notice");

  if (textParts.length === 0 && systemNoticeParts.length > 0) {
    return (
      <div className="w-full">
        {systemNoticeParts.map((part) => <SystemNoticeBlock key={part.id} part={part} />)}
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 items-start justify-end">
      <div className="flex flex-col items-end gap-1 max-w-[80%]">
        {textParts.map((part) => (
          <div key={part.id} className="bg-bg-overlay border border-border-subtle rounded-2xl rounded-br-sm px-3.5 py-2 text-[13.5px] leading-relaxed text-text-primary whitespace-pre-wrap break-words">
            {part.text}
          </div>
        ))}
        <span className="text-[11px] text-text-muted">{formatRelativeTime(message.createdAt)}</span>
      </div>
      <div className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center shrink-0">
        <User size={18} />
      </div>
    </div>
  );
}

function PendingMessageBubble({
  message,
  projectSlug,
  sessionId,
  steerTargetExecutionId,
}: {
  message: PendingSessionMessage;
  projectSlug: string;
  sessionId: string;
  steerTargetExecutionId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const editMessage = useEditPendingMessage();
  const deleteMessage = useDeletePendingMessage();
  const steerMessage = useSteerPendingMessage();
  const canSteer = message.state === "queued"
    && typeof steerTargetExecutionId === "string"
    && steerTargetExecutionId.length > 0;

  const saveEdit = () => {
    const content = draft.trim();
    if (!content || content === message.content || editMessage.isPending) return;
    editMessage.mutate({
      slug: projectSlug,
      sessionId,
      messageId: message.id,
      expectedRevision: message.revision,
      content,
    }, { onSuccess: () => setEditing(false) });
  };

  return (
    <div className="flex gap-2.5 items-start justify-end" data-testid={`pending-message-${message.id}`}>
      <div className="flex flex-col items-end gap-1 max-w-[80%]">
        {editing ? (
          <div className="flex flex-col gap-2 rounded-2xl rounded-br-sm border border-accent bg-bg-overlay p-2.5">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-w-[220px] resize-y rounded-md border border-border-default bg-bg-base px-2.5 py-2 text-[13.5px] leading-relaxed text-text-primary outline-none focus:border-accent"
              rows={Math.min(8, Math.max(2, draft.split("\n").length))}
              autoFocus
            />
            <div className="flex justify-end gap-1.5">
              <button type="button" className="rounded px-2 py-1 text-[11px] text-text-tertiary hover:bg-bg-hover" onClick={() => { setDraft(message.content); setEditing(false); }}>Cancel</button>
              <button type="button" className="rounded bg-accent px-2 py-1 text-[11px] text-bg-base disabled:opacity-40" disabled={!draft.trim() || editMessage.isPending} onClick={saveEdit}>Save</button>
            </div>
          </div>
        ) : (
          <div className="bg-bg-overlay border border-border-subtle rounded-2xl rounded-br-sm px-3.5 py-2 text-[13.5px] leading-relaxed text-text-primary whitespace-pre-wrap break-words">
            {message.content}
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <span>{message.state === "steering" ? "Steering…" : "Queued"}</span>
          {message.state === "queued" && (
            <>
              {canSteer && (
                <button
                  type="button"
                  className="text-accent hover:underline disabled:opacity-40"
                  disabled={steerMessage.isPending}
                  onClick={() => steerMessage.mutate({
                    slug: projectSlug,
                    sessionId,
                    messageId: message.id,
                    expectedRevision: message.revision,
                    expectedExecutionId: steerTargetExecutionId!,
                  })}
                >
                  Steer
                </button>
              )}
              <button
                type="button"
                className="hover:text-text-primary disabled:opacity-40"
                disabled={editMessage.isPending || deleteMessage.isPending}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-error hover:underline disabled:opacity-40"
                disabled={editMessage.isPending || deleteMessage.isPending}
                onClick={() => deleteMessage.mutate({
                  slug: projectSlug,
                  sessionId,
                  messageId: message.id,
                  expectedRevision: message.revision,
                })}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      <div className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center shrink-0">
        <User size={18} />
      </div>
    </div>
  );
}

function MsgAgent({
  message,
  agentName,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agents,
}: {
  message: SessionMessage;
  agentName: string | null;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: ToolChildSessionLink[];
  agents: readonly AgentDescriptor[];
}) {
  const displayName = resolveAgentDisplayName(agentName, agents);
  const appearance = resolveAgentAppearance(agentName, displayName);

  return (
    <div className="group flex flex-col gap-1.5 max-w-full">
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`w-2 h-2 rounded-full ${appearance.dotClass}`} />
        <span className={`text-[13px] ${appearance.nameClass}`}>{displayName}</span>
        <span className="text-[11px] text-text-muted">{formatRelativeTime(message.createdAt)}</span>
        <button type="button" className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary ml-auto p-1" aria-label="More actions">
          <Ellipsis size={14} />
        </button>
      </div>
      <div className={`border-l-2 pl-3 bg-bg-surface/30 rounded-r-lg py-1.5 pr-3 ${appearance.borderClass}`}>
        <div className="msg-parts">
          {groupReadOnlyToolParts(message.parts).map((entry) => {
            if (entry.type === "grouped-tools") {
              return <GroupedToolCard key={entry.id} tools={entry.tools} />;
            }
            const part = entry as SessionPart;
            return <PartRenderer key={part.id} part={part} projectSlug={projectSlug} focusStoreSessionId={focusStoreSessionId} childSessionLinks={childSessionLinks} agentDescriptors={agents} />;
          })}
        </div>
      </div>
    </div>
  );
}

function SystemNoticeBlock({ part }: { part: SystemNoticePart }) {
  return (
    <div className="flex items-center gap-3 my-1">
      <div className="flex-1 h-px bg-border-subtle" />
      <Info size={12} className="text-text-muted shrink-0" />
      <span className="text-[11px] text-text-muted">{part.notice}</span>
      <div className="flex-1 h-px bg-border-subtle" />
    </div>
  );
}

function CompactionBlock({ part }: { part: { type: "compaction"; summary: string; tailStartId: string; compactedAt: number } }) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden my-2.5 shrink-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-elevated border-b border-border-subtle">
        <Info size={12} className="text-text-muted shrink-0" />
        <span className="text-[11px] text-text-muted font-medium">Hard context compaction</span>
        <span className="text-[11px] text-text-muted ml-auto">{formatRelativeTime(part.compactedAt)}</span>
      </div>
      <div className="px-3 py-2 text-[12px] text-text-secondary leading-relaxed whitespace-pre-wrap">
        {part.summary}
      </div>
    </div>
  );
}

export function parseToolOutput(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  try { return JSON.parse(output); } catch { return null; }
}

function DelegateToolCard({
  part,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors,
}: {
  part: ToolPart;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: ToolChildSessionLink[];
  agentDescriptors: readonly AgentDescriptor[];
}) {
  return <DelegationCard {...buildDelegationCardViewModel({
    part,
    projectSlug,
    focusStoreSessionId,
    childSessionLinks,
    agentDescriptors,
  })} />;
}

function InterruptedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-warning-muted text-warning border border-warning/20">
      <TriangleAlert size={12} /> Response was interrupted
    </span>
  );
}

export function PartRenderer({ part, projectSlug, focusStoreSessionId, childSessionLinks, agentDescriptors = [] }: { part: SessionPart; projectSlug: string; focusStoreSessionId: string; childSessionLinks: ToolChildSessionLink[]; agentDescriptors?: readonly AgentDescriptor[] }) {
  switch (part.type) {
    case "text": {
      const meta = part.meta as Record<string, unknown> | undefined;
      const isInterrupted = meta?.interrupted === true;
      return (
        <div className="text-[13.5px] leading-relaxed text-text-primary">
          {isInterrupted && <InterruptedBadge />}
          <MarkdownContent isStreaming={!part.completedAt}>{part.text}</MarkdownContent>
        </div>
      );
    }
    case "reasoning": {
      const meta = part.meta as Record<string, unknown> | undefined;
      const isInterrupted = meta?.interrupted === true;
      return (
        <div>
          {isInterrupted && <InterruptedBadge />}
          <ReasoningBlock part={part} />
        </div>
      );
    }
    case "tool":
      if (part.toolName === TOOL_DELEGATE) {
        return <DelegateToolCard part={part} projectSlug={projectSlug} focusStoreSessionId={focusStoreSessionId} childSessionLinks={childSessionLinks} agentDescriptors={agentDescriptors} />;
      }
      return <ToolCard part={part} />;
    case "system-notice":
      return <SystemNoticeBlock part={part} />;
    case "compaction":
      return <CompactionBlock part={part} />;
    case "recovery-notice":
      return <RecoveryNotice part={part} />;
    default:
      return null;
  }
}

interface ChatMessagesProps {
  slug: string;
  sessionId: string;
  agents: readonly AgentDescriptor[];
}

interface LocalSendingMessage {
  readonly clientRequestId: string;
  readonly content: string;
  readonly createdAt: number;
  readonly status: "sending" | "retryable";
}

function LocalSendingMessageBubble({
  message,
  slug,
  sessionId,
}: {
  message: LocalSendingMessage;
  slug: string;
  sessionId: string;
}) {
  const retry = usePostMessage();
  const retryMessage = useCallback(() => {
    const store = getWebSessionStore(sessionId, slug).getState();
    store.setLocalSendingMessageStatus(message.clientRequestId, "sending");
    retry.mutate(
      {
        slug,
        sessionId,
        content: message.content,
        clientRequestId: message.clientRequestId,
      },
      {
        onSuccess: (acceptance) => {
          if (acceptance.status === "command") {
            getWebSessionStore(sessionId, slug).getState().removeLocalSendingMessage(message.clientRequestId);
          }
        },
        onError: (error) => {
          const current = getWebSessionStore(sessionId, slug).getState();
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            current.removeLocalSendingMessage(message.clientRequestId);
            return;
          }
          current.setLocalSendingMessageStatus(message.clientRequestId, "retryable");
        },
      },
    );
  }, [message, retry, sessionId, slug]);

  const retryable = message.status === "retryable" && !retry.isPending;
  return (
    <div className="flex gap-2.5 items-start justify-end" data-testid={`sending-message-${message.clientRequestId}`}>
      <div className="flex flex-col items-end gap-1 max-w-[80%]">
        <div className="bg-bg-overlay border border-border-subtle rounded-2xl rounded-br-sm px-3.5 py-2 text-[13.5px] leading-relaxed text-text-primary whitespace-pre-wrap break-words opacity-75">
          {message.content}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <span>{retryable ? "Send status unknown" : "Sending…"}</span>
          {retryable && (
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={retryMessage}
              aria-label="Retry sending message"
            >
              Retry
            </button>
          )}
        </div>
      </div>
      <div className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center shrink-0">
        <User size={18} />
      </div>
    </div>
  );
}

export function ChatMessages({ slug, sessionId, agents }: ChatMessagesProps) {
  const messages = useSessionStore(sessionId, (s) => s.messages, slug);
  const pendingMessages = useSessionStore(sessionId, (s) => s.pendingMessages, slug);
  const localSendingMessages = useSessionStore(sessionId, (s) => s.localSendingMessages, slug);
  const rootSessionId = useSessionStore(sessionId, (s) => s.rootSessionId, slug);
  const isRootSession = sessionId === rootSessionId;
  const steerTargetExecutionId = useSessionFamilySteerTargetExecutionId(slug, sessionId);
  const focusStoreSessionId = useSessionStore(sessionId, (s) => s.rootSessionId, slug);
  const childSessionLinks = useSessionStore(sessionId, (s) => s.childSessionLinks, slug);
  const agentName = useSessionStore(sessionId, (s) => s.agentName, slug);
  const compressionBlocks = useSessionStore(sessionId, (s) => s.compressionBlocks ?? [], slug);
  const compression = useSessionStore(sessionId, (s) => s.compression, slug);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 100;
    setIsNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
  }, []);

  useEffect(() => {
    if (isNearBottom && sentinelRef.current) {
      sentinelRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, pendingMessages, localSendingMessages, compressionBlocks, isNearBottom]);

  const visiblePendingMessages = isRootSession ? pendingMessages : [];
  const visibleLocalSendingMessages = isRootSession ? localSendingMessages : [];

  if (messages.length === 0 && visiblePendingMessages.length === 0 && visibleLocalSendingMessages.length === 0 && compressionBlocks.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5 max-w-3xl mx-auto w-full items-center justify-center text-text-muted text-sm">
        No messages yet
      </div>
    );
  }

  type StreamEntry =
    | { kind: "message"; message: SessionMessage }
    | { kind: "pending"; message: PendingSessionMessage }
    | { kind: "sending"; message: LocalSendingMessage }
    | { kind: "compression"; block: CompressionBlockPart };

  const transcriptEntries: Array<{ entry: StreamEntry; time: number; order: number }> = [];
  let lastCanonicalTime = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    lastCanonicalTime = Math.max(lastCanonicalTime, message.createdAt);
    transcriptEntries.push({
      entry: { kind: "message", message },
      time: lastCanonicalTime,
      order: transcriptEntries.length,
    });
  }
  for (const block of compressionBlocks) {
    transcriptEntries.push({
      entry: { kind: "compression", block },
      time: block.committedAt,
      order: transcriptEntries.length,
    });
  }
  transcriptEntries.sort((left, right) => left.time - right.time || left.order - right.order);

  const pendingEntries: Array<{ entry: StreamEntry; time: number; order: number }> = [];
  const durableRequestIds = new Set(visiblePendingMessages.map((message) => message.clientRequestId));
  for (const message of visiblePendingMessages) {
    pendingEntries.push({
      entry: { kind: "pending", message },
      time: message.acceptedAt,
      order: pendingEntries.length,
    });
  }
  for (const message of visibleLocalSendingMessages) {
    if (durableRequestIds.has(message.clientRequestId)) continue;
    pendingEntries.push({
      entry: { kind: "sending", message },
      time: message.createdAt,
      order: pendingEntries.length,
    });
  }
  pendingEntries.sort((left, right) => left.time - right.time || left.order - right.order);
  const entries = [
    ...transcriptEntries.map(({ entry }) => entry),
    ...pendingEntries.map(({ entry }) => entry),
  ];

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-5 flex flex-col gap-5 max-w-3xl mx-auto w-full"
    >
      {entries.map((entry) => {
        if (entry.kind === "compression") {
          return (
            <CompressionBlock
              key={`compression-${entry.block.blockRef}-${entry.block.id}`}
              part={entry.block}
              projectSlug={slug}
              sessionId={sessionId}
              focusStoreSessionId={focusStoreSessionId}
              snapshot={compression?.blocksByRef[entry.block.blockRef]}
              childSessionLinks={childSessionLinks}
              agentDescriptors={agents}
            />
          );
        }
        if (entry.kind === "pending") {
          return (
            <PendingMessageBubble
              key={`pending-${entry.message.id}`}
              message={entry.message}
              projectSlug={slug}
              sessionId={sessionId}
              steerTargetExecutionId={steerTargetExecutionId}
            />
          );
        }
        if (entry.kind === "sending") {
          return (
            <LocalSendingMessageBubble
              key={`sending-${entry.message.clientRequestId}`}
              message={entry.message}
              slug={slug}
              sessionId={sessionId}
            />
          );
        }
        const msg = entry.message;
        if (msg.role === "user") {
          return <MsgUser key={msg.id} message={msg} />;
        }
        return <MsgAgent key={msg.id} message={msg} agentName={agentName} projectSlug={slug} focusStoreSessionId={focusStoreSessionId} childSessionLinks={childSessionLinks} agents={agents} />;
      })}
      <div ref={sentinelRef} />
    </div>
  );
}
