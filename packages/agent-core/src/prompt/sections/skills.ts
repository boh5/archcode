import type { PromptContext } from "../types";

export async function buildSkillsSection(ctx: PromptContext): Promise<string | null> {
  const available = ctx.availableSkills;
  const active = ctx.activeSkills;

  if ((available === undefined || available.length === 0) && (active === undefined || active.length === 0)) {
    return null;
  }

  const parts: string[] = ["## Skills"];

  if (available !== undefined && available.length > 0) {
    const entries = available.map((s) => {
      let line = `- **${s.name}** — ${s.description} (source: ${s.source})`;
      if (s.allowed_tools !== undefined && s.allowed_tools.length > 0) {
        line += ` [allowed_tools: ${s.allowed_tools.join(", ")}]`;
      }
      return line;
    });
    parts.push(`<available-skills>\n${entries.join("\n")}\n</available-skills>`);
  }

  if (active !== undefined && active.length > 0) {
    const entries = active.map((s) => {
      const header = `### ${s.metadata.name} (${s.source})`;
      return `${header}\n\n${s.body}`;
    });
    parts.push(`<active-skills>\n${entries.join("\n\n---\n\n")}\n</active-skills>`);
  }

  return parts.join("\n\n");
}
