import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ReasoningPart } from "@archcode/protocol";
import { MarkdownContent } from "../primitives/MarkdownContent";

export function ReasoningBlock({ part }: { readonly part: ReasoningPart }) {
  const [expanded, setExpanded] = useState(false);
  const streaming = !part.completedAt;

  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
      <button
        type="button"
        className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-left text-[12px] text-text-tertiary hover:bg-bg-hover"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <ChevronRight size={12} className={`transition-transform duration-[var(--motion-icon)] ${expanded ? "rotate-90" : ""}`} />
        <Sparkles size={12} className={`text-text-muted ${streaming ? "animate-streaming" : ""}`} aria-hidden="true" />
        <span>{streaming ? "Thinking…" : "Reasoning"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border-subtle px-3 pb-2 text-[13px] italic leading-5 text-text-secondary">
          <MarkdownContent isStreaming={streaming}>{part.text}</MarkdownContent>
        </div>
      )}
    </div>
  );
}
