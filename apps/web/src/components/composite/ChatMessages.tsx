import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../store/session-store";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { ToolCard } from "./ToolCard";
import { DelegationCard } from "./DelegationCard";
import type { DelegationCardProps } from "./DelegationCard";
import {
  AGENT_INITIALS,
  AGENT_ICON_COLORS,
  AGENT_DISPLAY_NAMES,
  isValidAgentType,
  type BadgeStatus,
} from "../../lib/agent-constants";
import type {
  SessionMessage,
  SessionPart,
  SystemNoticePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolChildSessionLink,
  ToolChildSessionLinkStatus,
} from "@specra/protocol";
import { TOOL_DELEGATE } from "@specra/protocol";
import { RecoveryNotice } from "./RecoveryNotice";
import type { AgentType } from "../../lib/agent-constants";
import { formatRelativeTime } from "../../lib/time-format";

function ReasoningBlock({ part }: { part: ReasoningPart }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-bg-overlay border border-border-subtle rounded-md overflow-hidden mb-2 shrink-0">
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-tertiary cursor-pointer select-none hover:bg-bg-hover w-full text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-[10px] transition-transform duration-150" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span>Reasoning</span>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2 text-[12.5px] text-text-secondary italic leading-relaxed border-t border-border-subtle">
          <MarkdownContent isStreaming={!part.completedAt}>{part.text}</MarkdownContent>
        </div>
      )}
    </div>
  );
}

function MsgUser({ message }: { message: SessionMessage }) {
  const textParts = message.parts.filter((p): p is TextPart => p.type === "text");

  return (
    <div className="flex gap-2.5 items-start justify-end">
      <div className="flex-1 min-w-0 flex flex-col items-end">
        {textParts.map((part) => (
          <div key={part.id} className="text-[13.5px] leading-relaxed text-text-primary">
            {part.text}
          </div>
        ))}
      </div>
      <div className="w-7 h-7 rounded-sm flex items-center justify-center text-[13px] shrink-0 bg-bg-active text-text-tertiary">
        U
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
}: {
  message: SessionMessage;
  agentName: string;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: ToolChildSessionLink[];
}) {
  const agentType = isValidAgentType(agentName) ? (agentName as AgentType) : "orchestrator" as AgentType;
  const initials = AGENT_INITIALS[agentType];
  const colorClasses = AGENT_ICON_COLORS[agentType];
  const displayName = AGENT_DISPLAY_NAMES[agentType];

  return (
    <div className="flex gap-2.5 items-start max-w-full">
      <div className={`w-7 h-7 rounded-sm flex items-center justify-center text-[13px] shrink-0 ${colorClasses}`}>
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-semibold text-[13px]">{displayName}</span>
          <span className="text-[11px] text-text-muted">{formatRelativeTime(message.createdAt)}</span>
        </div>
        <div className="msg-parts">
          {message.parts.map((part) => (
            <PartRenderer key={part.id} part={part} projectSlug={projectSlug} focusStoreSessionId={focusStoreSessionId} childSessionLinks={childSessionLinks} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SystemNoticeBlock({ part }: { part: SystemNoticePart }) {
  return (
    <div className="text-center text-[12px] text-text-muted italic py-1">
      {part.notice}
    </div>
  );
}

function CompactionBlock() {
  return (
    <div className="text-center text-[11px] text-text-muted py-1">
      Context compacted — earlier messages summarized
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
    case "running":
    case "linked": return "running";
    case "cancelling": return "running";
    case "failed":
    case "timed_out":
    case "cancelled":
    case "interrupted": return "error";
  }
}

function DelegateToolCard({ part, projectSlug, focusStoreSessionId, childSessionLinks }: { part: ToolPart; projectSlug: string; focusStoreSessionId: string; childSessionLinks: ToolChildSessionLink[] }) {
  const parsedInput = parseToolInput("input" in part ? part.input : undefined);

  const link = childSessionLinks.find((l) => l.parentToolCallId === part.toolCallId);

  const sessionId = link?.childSessionId ?? "";
  const agentType = link?.childAgentName ?? (parsedInput?.agent_type as string) ?? "explorer";
  const agentName = link?.title ?? link?.description ?? (parsedInput?.description as string) ?? (parsedInput?.title as string) ?? "Sub-agent";
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
    agentName,
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
      ⚠ Response was interrupted
    </span>
  );
}

export function PartRenderer({ part, projectSlug, focusStoreSessionId, childSessionLinks }: { part: SessionPart; projectSlug: string; focusStoreSessionId: string; childSessionLinks: ToolChildSessionLink[] }) {
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
        return <DelegateToolCard part={part} projectSlug={projectSlug} focusStoreSessionId={focusStoreSessionId} childSessionLinks={childSessionLinks} />;
      }
      return <ToolCard part={part} />;
    case "system-notice":
      return <SystemNoticeBlock part={part} />;
    case "compaction":
      return <CompactionBlock />;
    case "recovery-notice":
      return <RecoveryNotice part={part} />;
    default:
      return null;
  }
}

interface ChatMessagesProps {
  slug: string;
  sessionId: string;
}

export function ChatMessages({ slug, sessionId }: ChatMessagesProps) {
  const messages = useSessionStore(sessionId, (s) => s.messages, slug);
  const focusStoreSessionId = useSessionStore(sessionId, (s) => s.rootSessionId, slug);
  const childSessionLinks = useSessionStore(sessionId, (s) => s.childSessionLinks, slug);

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
  }, [messages, isNearBottom]);

  function getAgentName(_msg: SessionMessage): string {
    return "orchestrator";
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4 items-center justify-center text-text-muted text-sm">
        No messages yet
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-5 flex flex-col gap-4"
    >
      {messages.map((msg) => {
        if (msg.role === "user") {
          return <MsgUser key={msg.id} message={msg} />;
        }
        return <MsgAgent key={msg.id} message={msg} agentName={getAgentName(msg)} projectSlug={slug} focusStoreSessionId={focusStoreSessionId} childSessionLinks={childSessionLinks} />;
      })}
      <div ref={sentinelRef} />
    </div>
  );
}
