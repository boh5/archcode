import type { PromptContext } from "./types";
import { buildEnvSection } from "./sections/env";
import { buildGuidelinesSection } from "./sections/guidelines";
import { buildIdentitySection } from "./sections/identity";
import { buildMemorySection } from "./sections/memory";
import { buildProjectSection } from "./sections/project";
import { buildRoleSection } from "./sections/roles";
import { buildSkillsSection } from "./sections/skills";
import { buildToolSection } from "./sections/tools";
import { buildCompressionSection } from "./sections/compression";

/**
 * Assemble the full system prompt from context.
 *
 * Section order: Identity → Role → Guidelines → Skills → Tools → Environment → Memory → Project Context
 */
export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const sections: string[] = [buildIdentitySection(ctx)];

  const roleSection = buildRoleSection(ctx);
  if (roleSection !== null) {
    sections.push(roleSection);
  }

  sections.push(buildGuidelinesSection());

  const skillsSection = await buildSkillsSection(ctx);
  if (skillsSection !== null) {
    sections.push(skillsSection);
  }

  sections.push(buildToolSection(ctx));

  const compressionSection = buildCompressionSection(ctx);
  if (compressionSection !== null) {
    sections.push(compressionSection);
  }

  sections.push(buildEnvSection(ctx.env));

  const memorySection = await buildMemorySection(ctx);
  if (memorySection !== null) {
    sections.push(memorySection);
  }

  if (ctx.agentsMd !== undefined) {
    sections.push(buildProjectSection(ctx.agentsMd));
  }

  return sections.join("\n\n");
}
