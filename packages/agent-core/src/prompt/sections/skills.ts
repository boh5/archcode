import type { PromptContext } from "../types";

const WHEN_TO_USE_MAX_LENGTH = 300;

function normalizeWhenToUse(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= WHEN_TO_USE_MAX_LENGTH) return normalized;
  const sliced = normalized.slice(0, WHEN_TO_USE_MAX_LENGTH);
  const lastBreak = sliced.search(/\s+\S*$/);
  return lastBreak !== -1
    ? normalized.slice(0, lastBreak) + "…"
    : sliced.slice(0, -1) + "…";
}

export async function buildSkillsSection(ctx: PromptContext): Promise<string | null> {
  const available = ctx.availableSkills;
  const active = ctx.activeSkills;

  if ((available === undefined || available.length === 0) && (active === undefined || active.length === 0)) {
    return null;
  }

  const parts: string[] = ["## Skills"];

  if (available !== undefined && available.length > 0) {
    const entries = available.map((s) => {
      let line = `- **${s.name}** — ${s.description} (source: ${s.source}). When to use: ${normalizeWhenToUse(s.when_to_use)}`;
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
