import type { PromptContext } from "../types";

export function buildRoleSection(ctx: PromptContext): string | null {
  return ctx.rolePrompt ?? null;
}