import type { CompressionRange, MessageRef } from "./types";
import type { CompletedToolPart, StoredMessage } from "../store/types";

export interface DeduplicatedToolOutputGroup {
  readonly key: string;
  readonly toolName: string;
  readonly keptRef: MessageRef;
  readonly duplicateRefs: MessageRef[];
  readonly count: number;
}

export function deduplicateCompletedToolOutputs(
  messages: readonly StoredMessage[],
  range: CompressionRange,
): DeduplicatedToolOutputGroup[] {
  const groups = new Map<string, { toolName: string; refs: MessageRef[] }>();

  forEachCompletedTool(messages, range, (part, ref) => {
    const key = normalizedToolOutputKey(part);
    const group = groups.get(key) ?? { toolName: part.toolName, refs: [] };
    group.refs.push(ref);
    groups.set(key, group);
  });

  return [...groups.entries()]
    .filter(([, group]) => group.refs.length > 1)
    .map(([key, group]) => ({
      key,
      toolName: group.toolName,
      keptRef: group.refs[0]!,
      duplicateRefs: group.refs.slice(1),
      count: group.refs.length,
    }));
}

function forEachCompletedTool(
  messages: readonly StoredMessage[],
  range: CompressionRange,
  visit: (part: CompletedToolPart, ref: MessageRef) => void,
): void {
  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const ref = `m${String(index + 1).padStart(4, "0")}` as MessageRef;
    for (const part of message.parts) {
      if (part.type === "tool" && part.state === "completed") visit(part, ref);
    }
  }
}

function normalizedToolOutputKey(part: CompletedToolPart): string {
  return stableStringify({
    toolName: part.toolName,
    input: normalizeValue(part.input),
    output: normalizeText(part.output),
  });
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
