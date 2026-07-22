import { useState } from "react";
import { ChevronRight, Layers, LoaderCircle, TriangleAlert, RotateCw, FileText, AlertCircle } from "lucide-react";
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
  "dynamic-range": "text-brand bg-brand-subtle",
};

const TRIGGER_LABEL: Record<CompressionTrigger, string> = {
  model_tool_call: "Model",
  soft_nudge_response: "Soft nudge",
  strong_nudge_response: "Strong nudge",
};

const STATUS_LABEL: Record<CompressionBlockStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  superseded: "Superseded",
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
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
      <div className="flex w-full select-none items-center gap-2 border-b border-border-subtle bg-transparent px-3 py-2 text-left">
        <ChevronRight size={14} className={`text-text-muted transition-transform duration-[var(--motion-hover)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        <Layers size={14} className="text-text-secondary shrink-0" />
        <span className="font-mono text-[12px] text-text-primary font-semibold">{part.blockRef}</span>
        <span className={`px-2 py-1 rounded-sm text-[11px] font-semibold ${STRATEGY_CLASS[part.strategy]}`}>
          {STRATEGY_LABEL[part.strategy]}
        </span>
        <span className="text-[11px] text-text-tertiary">
          {TRIGGER_LABEL[part.trigger]}
        </span>
        <span className="ml-auto text-[11px] text-text-tertiary">
          {STATUS_LABEL[part.status]}
        </span>
        <span className="text-[11px] text-text-tertiary">
          {formatRelativeTime(part.committedAt)}
        </span>
      </div>

      <div className="px-3 py-2 flex flex-wrap gap-2 border-b border-border-subtle">
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

      <div className="px-3 py-3 text-[13px] text-text-secondary leading-5">
        <MarkdownContent>{part.summary}</MarkdownContent>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-sm bg-brand-subtle px-3 text-[12px] font-medium text-brand transition-colors duration-[var(--motion-hover)] hover:bg-brand-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          onClick={handleToggleOriginalRange}
        >
          {expanded ? "Hide original range ↑" : "Show original range ↓"}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border-subtle">
          {expansion.status === "loading" && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-text-tertiary">
              <LoaderCircle size={12} className="animate-activity" />
              <span>Loading original range…</span>
            </div>
          )}
          {expansion.status === "error" && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-error">
              <TriangleAlert size={12} />
              <span className="flex-1">{expansion.message}</span>
              <button
                type="button"
                className="flex h-8 cursor-pointer items-center gap-1 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-sm bg-bg-active text-[11px] text-text-tertiary font-mono">
      <span className="text-text-tertiary">{label}</span>
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
    <div className="px-3 py-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
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
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-overlay border-b border-border-subtle">
        <span className="font-mono text-[11px] text-text-tertiary">{ref}</span>
        <span className="text-[11px] text-text-tertiary">{message.role}</span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">
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
        <div className="flex items-start gap-2 text-[13px] leading-5 text-text-secondary">
          <FileText size={11} className="text-text-muted shrink-0 mt-1" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{part.text}</span>
        </div>
      );
    case "reasoning":
      return (
        <div className="flex items-start gap-2 text-[12px] leading-4 text-text-tertiary italic">
          <FileText size={11} className="text-text-muted shrink-0 mt-1" aria-hidden="true" />
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
        <div className="flex items-start gap-2 text-[11px] text-text-tertiary">
          <AlertCircle size={11} className="shrink-0 mt-1" />
          <span>{part.notice}</span>
        </div>
      );
    case "compaction":
      return (
        <div className="flex items-start gap-2 text-[11px] text-text-tertiary">
          <Layers size={11} className="shrink-0 mt-1" />
          <span>Hard context compaction: {part.summary.slice(0, 80)}{part.summary.length > 80 ? "…" : ""}</span>
        </div>
      );
    case "recovery-notice":
      return (
        <div className="flex items-start gap-2 text-[11px] text-text-tertiary">
          <AlertCircle size={11} className="shrink-0 mt-1" />
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
