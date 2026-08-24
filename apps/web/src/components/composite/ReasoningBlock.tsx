import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ReasoningPart } from "@archcode/protocol";
import { WORK_ACTIVITY_CHILD_LANE_CLASS } from "../primitives/ConversationRail";
import { MarkdownContent } from "../primitives/MarkdownContent";

export function ReasoningBlock({ part }: { readonly part: ReasoningPart }) {
  const [expanded, setExpanded] = useState(false);
  if (part.text.trim().length === 0) return null;

  const streaming = !part.completedAt;
  const bodyId = `reasoning-body-${part.id}`;

  return (
    <section className="w-full min-w-0 shrink-0" data-testid="reasoning-block">
      <button
        type="button"
        className={`reasoning-summary-control flex min-h-9 cursor-pointer select-none items-center gap-[7px] rounded px-2 text-left text-[12px] text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11 ${WORK_ACTIVITY_CHILD_LANE_CLASS}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <ChevronRight size={11} className={`shrink-0 text-text-muted transition-transform duration-[var(--motion-fast)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        <Sparkles size={12} className={`text-text-muted ${streaming ? "animate-streaming" : ""}`} aria-hidden="true" />
        <span className="font-medium">{streaming ? "Thinking…" : "Reasoning"}</span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="mb-1.5 ml-[18px] mr-1.5 mt-px max-w-[72ch] border-l border-border-default px-[9px] py-[7px] text-[12px] leading-[1.55] text-text-secondary"
          data-testid="reasoning-body"
        >
          <MarkdownContent isStreaming={streaming} variant="compact">{part.text}</MarkdownContent>
        </div>
      )}
    </section>
  );
}
