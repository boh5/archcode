import type { ToolCatalog } from "./types";

export const MAX_NAMESPACE_SUMMARY_ITEM_BYTES = 120;
export const MAX_NAMESPACE_SUMMARY_BYTES = 4 * 1024;

export interface ToolNamespaceSummaryInput {
  readonly catalog: ToolCatalog;
  readonly descriptions?: Readonly<Record<string, string>>;
}

export function buildToolNamespaceSummary(input: ToolNamespaceSummaryInput): string {
  const counts = new Map<string, number>();
  for (const entry of input.catalog.entries) counts.set(entry.namespace, (counts.get(entry.namespace) ?? 0) + 1);
  const lines = [...counts]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([namespace, count]) => truncateUtf8(
      `${namespace}: ${input.descriptions?.[namespace] ?? "available tools"} (${count})`,
      MAX_NAMESPACE_SUMMARY_ITEM_BYTES,
    ));
  const included: string[] = [];
  let omitted = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const candidate = [...included, lines[index]!];
    const suffix = remaining > 0 ? `\n... ${remaining} namespaces omitted` : "";
    if (utf8Bytes(candidate.join("\n") + suffix) > MAX_NAMESPACE_SUMMARY_BYTES) {
      omitted = lines.length - index;
      break;
    }
    included.push(lines[index]!);
  }
  const suffix = omitted > 0 ? `\n... ${omitted} namespaces omitted` : "";
  return truncateUtf8(included.join("\n") + suffix, MAX_NAMESPACE_SUMMARY_BYTES);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const ellipsis = "...";
  if (maxBytes <= ellipsis.length) return ellipsis.slice(0, maxBytes);
  let end = maxBytes - ellipsis.length;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end)) + ellipsis;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
