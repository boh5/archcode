import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessionStore } from "../../store/session-store";
import { MarkdownContent } from "../primitives/MarkdownContent";
import type {
  SessionMessage,
  SessionPart,
  ToolPart,
  CompactionPart,
  SystemNoticePart,
  ReasoningPart,
  TextPart,
} from "@specra/protocol";

const AGENT_TYPES = [
  "orchestrator",
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
  "explorer",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];

const AGENT_INITIALS: Record<AgentType, string> = {
  orchestrator: "O",
  product: "P",
  spec: "S",
  critic: "C",
  foreman: "F",
  builder: "B",
  reviewer: "R",
  librarian: "L",
  explorer: "E",
};

const AGENT_ICON_COLORS: Record<AgentType, string> = {
  orchestrator: "bg-agent-orchestrator/20 text-agent-orchestrator",
  product: "bg-agent-product/20 text-agent-product",
  spec: "bg-agent-spec/20 text-agent-spec",
  critic: "bg-agent-critic/20 text-agent-critic",
  foreman: "bg-agent-foreman/20 text-agent-foreman",
  builder: "bg-agent-builder/20 text-agent-builder",
  reviewer: "bg-agent-reviewer/20 text-agent-reviewer",
  librarian: "bg-agent-librarian/20 text-agent-librarian",
  explorer: "bg-agent-explorer/20 text-agent-explorer",
};

const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  orchestrator: "Orchestrator",
  product: "Product",
  spec: "Spec",
  critic: "Critic",
  foreman: "Foreman",
  builder: "Builder",
  reviewer: "Reviewer",
  librarian: "Librarian",
  explorer: "Explorer",
};

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function isValidAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

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

function ToolCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);

  const statusConfig: Record<
    ToolPart["state"],
    { icon: string; bgClass: string; textClass: string; animate?: string }
  > = {
    pending: { icon: "⏳", bgClass: "bg-warning-muted", textClass: "text-warning" },
    running: { icon: "⟳", bgClass: "bg-info-muted", textClass: "text-info", animate: "animate-spin" },
    completed: { icon: "✓", bgClass: "bg-success-muted", textClass: "text-success" },
    error: { icon: "✗", bgClass: "bg-error-muted", textClass: "text-error" },
  };

  const config = statusConfig[part.state];
  const nameClass =
    part.state === "completed"
      ? "text-text-tertiary"
      : part.state === "running"
        ? "text-accent"
        : "text-text-secondary";

  const outputText = part.state === "completed"
    ? (part as { output: string }).output
    : part.state === "error"
      ? (part as { errorMessage: string }).errorMessage
      : null;

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || !outputText) {
      setIsLong(false);
      setExpanded(false);
      return;
    }
    const style = getComputedStyle(el);
    const parsedLh = parseFloat(style.lineHeight);
    const fontSize = parseFloat(style.fontSize);
    const lh = Number.isFinite(parsedLh) && parsedLh > 0
      ? parsedLh
      : Number.isFinite(fontSize) && fontSize > 0
        ? fontSize * 1.625
        : 0;
    if (lh <= 0) {
      setIsLong(false);
      setExpanded(false);
      return;
    }
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const threshold = Math.ceil(lh * 5 + paddingTop + paddingBottom);
    const nextIsLong = el.scrollHeight > threshold;
    setIsLong(nextIsLong);
    if (!nextIsLong) setExpanded(false);
  }, [outputText]);

  useLayoutEffect(() => {
    if (expanded || !isLong) return;
    const el = contentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expanded, isLong, outputText]);

  return (
    <div className="bg-bg-overlay border border-border-default rounded-md overflow-hidden my-1.5 shrink-0">
      <button
        type="button"
        disabled={!isLong}
        aria-expanded={isLong ? expanded : undefined}
        className={`flex items-center gap-2 px-2.5 py-1.5 select-none transition-colors duration-150 w-full text-left ${
          isLong ? "cursor-pointer hover:bg-bg-hover" : "cursor-default disabled:opacity-100"
        }`}
        onClick={() => { if (isLong) setExpanded((v) => !v); }}
      >
        <span
          className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] shrink-0 ${config.bgClass} ${config.textClass} ${config.animate ?? ""}`}
        >
          {config.icon}
        </span>
        <span className={`text-xs font-medium font-mono ${nameClass}`}>
          {part.toolName}
        </span>
        {part.state === "completed" && (
          <span className="ml-auto text-[11px] text-text-muted">done</span>
        )}
        {part.state === "running" && (
          <span className="ml-auto text-[11px] text-text-muted">running…</span>
        )}
        {part.state === "pending" && (
          <span className="ml-auto text-[11px] text-text-muted">pending</span>
        )}
        {part.state === "error" && (
          <span className="ml-auto text-[11px] text-text-muted">error</span>
        )}
        {isLong && (
          <span
            className="text-text-muted text-[10px] transition-transform duration-150"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▶
          </span>
        )}
      </button>
      {outputText && (
        <div className="border-t border-border-subtle px-2.5 py-2">
          <pre
            ref={contentRef}
            className={`font-mono text-[11.5px] leading-relaxed bg-bg-elevated p-1.5 rounded-sm border border-border-subtle whitespace-pre-wrap break-all overflow-x-auto ${
              isLong && !expanded ? "overflow-y-auto" : ""
            } ${
              part.state === "completed" ? "text-success" : part.state === "error" ? "text-error" : "text-text-secondary"
            }`}
            style={isLong && !expanded ? { maxHeight: "calc(8.125em + 0.75rem + 2px)" } : undefined}
          >
            {outputText}
          </pre>
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
}: {
  message: SessionMessage;
  agentName: string;
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
            <PartRenderer key={part.id} part={part} />
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

function CompactionBlock({ part }: { part: CompactionPart }) {
  return (
    <div className="text-center text-[11px] text-text-muted py-1">
      Context compacted — earlier messages summarized
    </div>
  );
}

function PartRenderer({ part }: { part: SessionPart }) {
  switch (part.type) {
    case "text":
      return (
        <div className="text-[13.5px] leading-relaxed text-text-primary">
          <MarkdownContent isStreaming={!part.completedAt}>{part.text}</MarkdownContent>
        </div>
      );
    case "reasoning":
      return <ReasoningBlock part={part} />;
    case "tool":
      return <ToolCard part={part} />;
    case "system-notice":
      return <SystemNoticeBlock part={part} />;
    case "compaction":
      return <CompactionBlock part={part} />;
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
  const subAgentDescriptions = useSessionStore(sessionId, (s) => s.subAgentDescriptions, slug);

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
        return <MsgAgent key={msg.id} message={msg} agentName={getAgentName(msg)} />;
      })}
      <div ref={sentinelRef} />
    </div>
  );
}
