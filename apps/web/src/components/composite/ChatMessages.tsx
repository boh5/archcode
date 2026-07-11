import { useCallback, useEffect, useRef, useState } from "react";
import { User, Ellipsis, ChevronRight, Sparkles, Info, TriangleAlert } from "lucide-react";
import { useSessionStore } from "../../store/session-store";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { ToolCard } from "./ToolCard";
import { DelegationCard } from "./DelegationCard";
import type { DelegationCardProps } from "./DelegationCard";
import { CompressionBlock } from "./CompressionBlock";
import {
  resolveAgentAppearance,
  resolveAgentDisplayName,
  type BadgeStatus,
} from "../../lib/agent-constants";
import type {
  AgentDescriptor,
  SessionMessage,
  SessionPart,
  SystemNoticePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolChildSessionLink,
  ToolChildSessionLinkStatus,
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

function MsgUser({ message }: { message: SessionMessage }) {
  const textParts = message.parts.filter((p): p is TextPart => p.type === "text");

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

export function parseToolInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return null; }
  }
  return null;
}

export function parseToolOutput(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  try { return JSON.parse(output); } catch { return null; }
}

export function mapLinkStatusToBadge(status: ToolChildSessionLinkStatus): BadgeStatus {
  switch (status) {
    case "completed": return "completed";
    case "waiting_for_human": return "pending";
    case "running":
    case "linked": return "running";
    case "cancelling": return "running";
    case "failed":
    case "timed_out":
    case "cancelled":
    case "interrupted": return "error";
  }
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
  const parsedInput = parseToolInput("input" in part ? part.input : undefined);

  const link = childSessionLinks.find((l) => l.parentToolCallId === part.toolCallId);

  const sessionId = link?.childSessionId ?? "";
  const agentType = link?.childAgentName ?? (parsedInput?.agent_type as string) ?? "unknown";
  const agentDisplayName = resolveAgentDisplayName(agentType, agentDescriptors);
  const taskTitle = link?.title ?? link?.description ?? (parsedInput?.title as string) ?? (parsedInput?.description as string);
  const summary = link?.summary ?? link?.description ?? (parsedInput?.description as string) ?? "";
  const status: BadgeStatus = link
    ? mapLinkStatusToBadge(link.status)
    : part.state === "error" ? "error" : "running";
  const depth = link?.depth ?? 1;
  const startedAt = link?.startedAt ?? ("startedAt" in part ? (part as { startedAt: number }).startedAt : part.createdAt);

  const delegationProps: DelegationCardProps = {
    sessionId,
    focusStoreSessionId,
    agentType,
    agentDisplayName,
    taskTitle,
    status,
    depth,
    startedAt,
    summary,
    tools: [],
    projectSlug,
    canNavigate: Boolean(link?.childSessionId),
  };

  return <DelegationCard {...delegationProps} />;
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

export function ChatMessages({ slug, sessionId, agents }: ChatMessagesProps) {
  const messages = useSessionStore(sessionId, (s) => s.messages, slug);
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
  }, [messages, compressionBlocks, isNearBottom]);

  if (messages.length === 0 && compressionBlocks.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5 max-w-3xl mx-auto w-full items-center justify-center text-text-muted text-sm">
        No messages yet
      </div>
    );
  }

  type StreamEntry =
    | { kind: "message"; message: SessionMessage }
    | { kind: "compression"; block: CompressionBlockPart };

  const entries: StreamEntry[] = [];
  for (const message of messages) {
    entries.push({ kind: "message", message });
  }
  for (const block of compressionBlocks) {
    entries.push({ kind: "compression", block });
  }
  entries.sort((a, b) => {
    const aTime = a.kind === "message" ? a.message.createdAt : a.block.committedAt;
    const bTime = b.kind === "message" ? b.message.createdAt : b.block.committedAt;
    return aTime - bTime;
  });

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
