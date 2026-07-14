import { TOOL_COMPRESS } from "../../tools/names";
import type { PromptContext } from "../types";

export function buildCompressionSection(ctx: PromptContext): string | null {
  if (!ctx.allowedTools.includes(TOOL_COMPRESS)) return null;

  const lines = [
    "## Compression Protocol",
    "- Ordinary automatic context reduction is handled by the runtime compact hook before model calls; it is not a model-callable tool.",
    "- Use compress for DCP-style active range compression when you can faithfully summarize a visible range yourself.",
    "- compress only accepts visible projection refs: startId/endId must be mNNNN refs or known bN block refs, never internal message ids.",
    "- The compress summary must be structured with all required sections and childBlockRefs.",
    "- When compressing over an active child block, include that child ref in childBlockRefs and write its placeholder like (b1) exactly once in the summary.",
    "- Do not compress protected content: running or unknown-result tools, active questions/permissions, <protect> ranges, sub-agent links, unconsumed reminders, or active todos.",
  ];

  return lines.join("\n");
}
