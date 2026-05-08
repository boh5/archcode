import type { PromptContext } from "../types";

export function buildIdentitySection(ctx: PromptContext): string {
  return `You are Specra, a coding assistant agent (${ctx.agentId}).`;
}