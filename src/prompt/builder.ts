import type { PromptContext } from "./types";
import { buildEnvSection } from "./sections/env";
import { buildGuidelinesSection } from "./sections/guidelines";
import { buildIdentitySection } from "./sections/identity";
import { buildProjectSection } from "./sections/project";
import { buildToolSection } from "./sections/tools";

/**
 * Assemble the full system prompt from context.
 *
 * Section order: Identity → Guidelines → Tools → Environment → Project Context
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [
    buildIdentitySection(ctx),
    buildGuidelinesSection(),
    buildToolSection(ctx),
    buildEnvSection(ctx.env),
  ];

  if (ctx.agentsMd !== undefined) {
    sections.push(buildProjectSection(ctx.agentsMd));
  }

  return sections.join("\n\n");
}