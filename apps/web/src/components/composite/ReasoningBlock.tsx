import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ReasoningPart } from "@archcode/protocol";
import { WORK_ACTIVITY_CHILD_LANE_CLASS } from "../primitives/ConversationRail";
import { MarkdownContent } from "../primitives/MarkdownContent";

export function ReasoningUsageSummary({ tokens }: { readonly tokens: number }) {
  const formattedTokens = Math.floor(tokens).toLocaleString();

  return (
    <div
      role="note"
      aria-label={`Reasoning used ${formattedTokens} tokens. Reasoning text was not provided by the model.`}
      className={`flex min-h-8 items-center gap-2 py-1 text-[12px] leading-4 text-text-tertiary ${WORK_ACTIVITY_CHILD_LANE_CLASS}`}
      data-testid="reasoning-usage-summary"
    >
      <Sparkles size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
      <span className="font-medium text-text-secondary">Reasoning</span>
      <span className="tabular-nums">{formattedTokens} tokens</span>
      <span>· text unavailable</span>
    </div>
  );
}

export function ReasoningBlock({ part }: { readonly part: ReasoningPart }) {
  const [expanded, setExpanded] = useState(false);
  const streaming = !part.completedAt;
  const bodyId = `reasoning-body-${part.id}`;

  return (
    <section className="w-full min-w-0 shrink-0" data-testid="reasoning-block">
      <button
        type="button"
        className={`reasoning-summary-control flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-0 pr-1.5 text-left text-[12px] text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${WORK_ACTIVITY_CHILD_LANE_CLASS}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <ChevronRight size={11} className={`shrink-0 text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        <Sparkles size={12} className={`text-text-muted ${streaming ? "animate-streaming" : ""}`} aria-hidden="true" />
        <span className="font-medium">{streaming ? "Thinking…" : "Reasoning"}</span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="ml-[6px] max-w-[72ch] border-l border-border-subtle py-1 pl-[14px] text-[13px] leading-5 text-text-secondary"
          data-testid="reasoning-body"
        >
          <MarkdownContent isStreaming={streaming} variant="compact">{part.text}</MarkdownContent>
        </div>
      )}
    </section>
  );
}
