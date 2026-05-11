import type { PromptContext } from "./types";
import { buildEnvSection } from "./sections/env";
import { buildGuidelinesSection } from "./sections/guidelines";
import { buildIdentitySection } from "./sections/identity";
import { buildMemorySection } from "./sections/memory";
import { buildProjectSection } from "./sections/project";
import { buildToolSection } from "./sections/tools";

/**
 * Assemble the full system prompt from context.
 *
 * Section order: Identity → Guidelines → Tools → Environment → Memory → Project Context
 */
export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const sections: string[] = [
    buildIdentitySection(ctx),
    buildGuidelinesSection(),
    buildToolSection(ctx),
    buildEnvSection(ctx.env),
  ];

  const memorySection = await buildMemorySection(ctx);
  if (memorySection !== null) {
    sections.push(memorySection);
  }

  if (ctx.agentsMd !== undefined) {
    sections.push(buildProjectSection(ctx.agentsMd));
  }

  return sections.join("\n\n");
}