import type { ToolCatalogEntry } from "./types";

export const MAX_DEFERRED_TOOL_DESCRIPTION_CHARACTERS = 160;

export function buildDeferredToolDirectory(entries: readonly ToolCatalogEntry[]): string | null {
  if (entries.length === 0) return null;

  const groups = new Map<string, ToolCatalogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.namespace) ?? [];
    group.push(entry);
    groups.set(entry.namespace, group);
  }

  const lines: string[] = [];
  for (const [namespace, tools] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    if (lines.length > 0) lines.push("");
    lines.push(`Namespace ${JSON.stringify(namespace)}:`);
    for (const tool of [...tools].sort((a, b) => compareText(a.registryName, b.registryName))) {
      const description = summarizeDescription(tool.description);
      lines.push(`- ${JSON.stringify(description.length === 0
        ? { name: tool.registryName }
        : { name: tool.registryName, description })}`);
    }
  }
  return lines.join("\n");
}

function summarizeDescription(value: string): string {
  const firstLine = value.split(/\r\n|[\n\r\u0085\u2028\u2029]/u, 1)[0]!.replace(/\s+/g, " ").trim();
  const characters = [...firstLine];
  if (characters.length <= MAX_DEFERRED_TOOL_DESCRIPTION_CHARACTERS) return firstLine;
  return `${characters.slice(0, MAX_DEFERRED_TOOL_DESCRIPTION_CHARACTERS - 3).join("")}...`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
