import { TOOL_COMPRESS } from "../../tools/names";
import type { PromptContext } from "../types";

export function buildCompressionSection(ctx: PromptContext): string | null {
  if (!ctx.allowedTools.includes(TOOL_COMPRESS)) return null;

  return `## Compression Protocol
- Use compress only with visible projection refs: startId/endId must be mNNNN refs or known bN block refs, never internal message ids.
- The summary must be structured with version: 1, all required sections, and childBlockRefs.
- When compressing over an active child block, include that child ref in childBlockRefs and write its placeholder like (b1) exactly once in the summary.
- Do not compress protected content: running or unknown-result tools, active questions/permissions, <protect> ranges, sub-agent links, unconsumed reminders, or active todos.`;
}
