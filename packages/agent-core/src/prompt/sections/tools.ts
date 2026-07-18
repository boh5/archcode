import type { PromptContext } from "../types";

export function buildToolSection(ctx: PromptContext): string {
  if (ctx.allowedTools.length === 0) {
    return "## Tools\n\nNo tools available.";
  }

  const toolList = ctx.allowedTools
    .map((name) => `- ${name}`)
    .join("\n");

  const usageRules = [
    "- When independent, non-interactive lookups are already known, issue them together in one model turn. ArchCode parallelizes concurrency-safe calls and serializes the rest; do not batch interactive or mutating operations.",
  ];

  return `## Tools\n\nAvailable tools:\n${toolList}\n\nUsage:\n${usageRules.join("\n")}`;
}
