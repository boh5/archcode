import type { PromptContext } from "../types";

export function buildToolSection(ctx: PromptContext): string {
  if (ctx.allowedTools.length === 0) {
    return "## Tools\n\nNo tools available.";
  }

  const toolList = ctx.allowedTools
    .map((name) => `- ${name}`)
    .join("\n");

  return `## Tools\n\nAvailable tools:\n${toolList}`;
}