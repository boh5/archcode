import { useState } from "react";
import { ChevronRight, Layers, LoaderCircle, AlertTriangle, RotateCw, FileText, AlertCircle } from "lucide-react";
import type {
  CompressionBlockPart,
  CompressionBlockSnapshot,
  CompressionBlockStatus,
  CompressionStrategy,
  CompressionTrigger,
  AgentDescriptor,
  ToolChildSessionLink,
} from "@archcode/protocol";
import { TOOL_DELEGATE } from "@archcode/protocol";
import { MarkdownContent } from "../primitives/MarkdownContent";
import { DelegationCard } from "./DelegationCard";
import { ToolCard } from "./ToolCard";
import { buildDelegationCardViewModel } from "../../lib/delegation-card-model";
import { fetchCompressionOriginalRange } from "../../api/compression";
import type {
  CompressionOriginalRangeEntry,
  CompressionOriginalRangeSuccess,
  OriginalRangePart,
} from "../../api/compression";
import { formatRelativeTime } from "../../lib/time-format";

const STRATEGY_LABEL: Record<CompressionStrategy, string> = {
  "dynamic-range": "Dynamic Range",
};

const STRATEGY_CLASS: Record<CompressionStrategy, string> = {
  "dynamic-range": "text-accent bg-accent-subtle",
};

const TRIGGER_LABEL: Record<CompressionTrigger, string> = {
  model_tool_call: "model",
  soft_nudge_response: "soft nudge",
  strong_nudge_response: "strong nudge",
};

const STATUS_LABEL: Record<CompressionBlockStatus, string> = {
  active: "active",
  inactive: "inactive",
  superseded: "superseded",
};

type ExpansionState =
  | { status: "collapsed" }
  | { status: "loading" }
  | { status: "loaded"; data: CompressionOriginalRangeSuccess }
  | { status: "error"; message: string };

export interface CompressionBlockProps {
  part: CompressionBlockPart;
  projectSlug: string;
  sessionId: string;
  focusStoreSessionId: string;
  snapshot?: CompressionBlockSnapshot;
  childSessionLinks?: ToolChildSessionLink[];
  agentDescriptors?: readonly AgentDescriptor[];
}

export function CompressionBlock({ part, projectSlug, sessionId, focusStoreSessionId, snapshot, childSessionLinks = [], agentDescriptors = [] }: CompressionBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [expansion, setExpansion] = useState<ExpansionState>({ status: "collapsed" });

  async function handleToggleOriginalRange(): Promise<void> {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (expansion.status === "loaded" || expansion.status === "loading") return;

    setExpansion({ status: "loading" });
    try {
      const data = await fetchCompressionOriginalRange(projectSlug, sessionId, part.blockRef);
      setExpansion({ status: "loaded", data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load original range";
      setExpansion({ status: "error", message });
    }
  }

  async function handleRetry(): Promise<void> {
    setExpansion({ status: "loading" });
    try {
      const data = await fetchCompressionOriginalRange(projectSlug, sessionId, part.blockRef);
      setExpansion({ status: "loaded", data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load original range";
      setExpansion({ status: "error", message });
    }
  }

  const hasTokenEstimate = snapshot?.tokenEstimate !== undefined;
  const savedTokens = snapshot?.tokenEstimate?.savedTokens;
  const hasSnapshot = snapshot !== undefined;
  const protectedCount = snapshot?.protectedRefs?.length;

  return (
    <div className="bg-bg-surface border border-border-default rounded-lg overflow-hidden shrink-0 transition-colors duration-150 hover:border-border-strong">
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-elevated border-b border-border-subtle w-full text-left select-none">
        <ChevronRight size={14} className={`text-text-muted transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
        <Layers size={14} className="text-text-secondary shrink-0" />
        <span className="font-mono text-[12px] text-text-primary font-semibold">{part.blockRef}</span>
        <span className={`px-1.5 py-0.5 rounded-sm text-[10.5px] font-semibold ${STRATEGY_CLASS[part.strategy]}`}>
          {STRATEGY_LABEL[part.strategy]}
        </span>
        <span className="text-[11px] text-text-muted">
          {TRIGGER_LABEL[part.trigger]}
        </span>
        <span className="text-[11px] text-text-muted ml-auto">
          {STATUS_LABEL[part.status]}
        </span>
        <span className="text-[11px] text-text-muted">
          {formatRelativeTime(part.committedAt)}
        </span>
      </div>

      <div className="px-3 py-2 flex flex-wrap gap-1.5 border-b border-border-subtle">
        <MetaPill label="range" value={`${part.startRef}–${part.endRef}`} />
        {part.childBlockRefs.length > 0 && (
          <MetaPill label="children" value={part.childBlockRefs.join(", ")} />
        )}
        {hasTokenEstimate && (
          <MetaPill label="saved" value={`${savedTokens ?? 0} tokens`} />
        )}
        {hasSnapshot && (
          <MetaPill label="protected" value={`${protectedCount ?? 0} refs`} />
        )}
      </div>

      <div className="px-3 py-2.5 text-[12.5px] text-text-secondary leading-[1.55]">
        <MarkdownContent>{part.summary}</MarkdownContent>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[11px] font-medium text-accent bg-accent-subtle hover:bg-accent-muted cursor-pointer transition-colors duration-150"
          onClick={handleToggleOriginalRange}
        >
          {expanded ? "Hide original range ↑" : "Show original range ↓"}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border-subtle">
          {expansion.status === "loading" && (
            <div className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-text-muted">
              <LoaderCircle size={12} className="animate-spin" />
              <span>Loading original range…</span>
            </div>
          )}
          {expansion.status === "error" && (
            <div className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-error">
              <AlertTriangle size={12} />
              <span className="flex-1">{expansion.message}</span>
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded-sm text-[11px] font-medium text-text-secondary bg-bg-active hover:bg-bg-hover cursor-pointer"
                onClick={handleRetry}
              >
                <RotateCw size={11} />
                Retry
              </button>
            </div>
          )}
          {expansion.status === "loaded" && (
            <OriginalRangeView
              data={expansion.data}
              projectSlug={projectSlug}
              focusStoreSessionId={focusStoreSessionId}
              childSessionLinks={childSessionLinks}
              agentDescriptors={agentDescriptors}
            />
          )}
          {expansion.status === "collapsed" && null}
        </div>
      )}
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-bg-active text-[10.5px] text-text-tertiary font-mono">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary">{value}</span>
    </span>
  );
}

function OriginalRangeView({
  data,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors,
}: {
  data: CompressionOriginalRangeSuccess;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: ToolChildSessionLink[];
  agentDescriptors: readonly AgentDescriptor[];
}) {
  return (
    <div className="px-3 py-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <MetaPill label="block" value={data.blockRef} />
        <MetaPill label="strategy" value={data.strategy} />
        <MetaPill label="covered" value={`${data.coveredRefs.length} msgs`} />
        {data.childBlockRefs.length > 0 && (
          <MetaPill label="child blocks" value={data.childBlockRefs.join(", ")} />
        )}
      </div>
      {data.messages.map((entry) => (
        <OriginalRangeEntry
          key={entry.message.id}
          entry={entry}
          projectSlug={projectSlug}
          focusStoreSessionId={focusStoreSessionId}
          childSessionLinks={childSessionLinks}
          agentDescriptors={agentDescriptors}
        />
      ))}
    </div>
  );
}

function OriginalRangeEntry({
  entry,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors,
}: {
  entry: CompressionOriginalRangeEntry;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: ToolChildSessionLink[];
  agentDescriptors: readonly AgentDescriptor[];
}) {
  const { ref, message } = entry;
  return (
    <div className="border border-border-subtle rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-overlay border-b border-border-subtle">
        <span className="font-mono text-[11px] text-text-muted">{ref}</span>
        <span className="text-[11px] text-text-tertiary">{message.role}</span>
      </div>
      <div className="px-2.5 py-1.5 flex flex-col gap-1.5">
        {message.parts.map((part) => (
          <OriginalRangePartView
            key={part.id}
            part={part}
            projectSlug={projectSlug}
            focusStoreSessionId={focusStoreSessionId}
            childSessionLinks={childSessionLinks}
            agentDescriptors={agentDescriptors}
          />
        ))}
      </div>
    </div>
  );
}

function OriginalRangePartView({
  part,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors,
}: {
  part: OriginalRangePart;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: ToolChildSessionLink[];
  agentDescriptors: readonly AgentDescriptor[];
}) {
  switch (part.type) {
    case "text":
      return (
        <div className="flex items-start gap-1.5 text-[12.5px] text-text-secondary leading-relaxed">
          <FileText size={11} className="text-text-muted shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words">{part.text}</span>
        </div>
      );
    case "reasoning":
      return (
        <div className="flex items-start gap-1.5 text-[12px] text-text-tertiary italic leading-relaxed">
          <FileText size={11} className="text-text-muted shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words">{part.text}</span>
        </div>
      );
    case "tool":
      if (part.toolName === TOOL_DELEGATE) {
        return (
          <DelegateRangeCard
            part={part}
            projectSlug={projectSlug}
            focusStoreSessionId={focusStoreSessionId}
            childSessionLinks={childSessionLinks}
            agentDescriptors={agentDescriptors}
          />
        );
      }
      return <ToolCard part={part} projectSlug={projectSlug} sessionId={focusStoreSessionId} />;
    case "system-notice":
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-text-muted">
          <AlertCircle size={11} className="shrink-0 mt-0.5" />
          <span>{part.notice}</span>
        </div>
      );
    case "compaction":
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-text-muted">
          <Layers size={11} className="shrink-0 mt-0.5" />
          <span>Hard context compaction: {part.summary.slice(0, 80)}{part.summary.length > 80 ? "…" : ""}</span>
        </div>
      );
    case "recovery-notice":
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-text-muted">
          <AlertCircle size={11} className="shrink-0 mt-0.5" />
          <span>{part.message}</span>
        </div>
      );
    default:
      return null;
  }
}

function DelegateRangeCard({
  part,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors,
}: {
  part: OriginalRangePart & { type: "tool" };
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
