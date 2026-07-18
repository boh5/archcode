import type { CompressionRange, MessageRef } from "./types";
import type { ErrorToolPart, StoredMessage } from "../store/types";
import { normalizeText, normalizeValue } from "./normalize";

export interface PurgedRepeatedErrorGroup {
  readonly key: string;
  readonly toolName: string;
  readonly preservedRefs: MessageRef[];
  readonly collapsedRefs: MessageRef[];
  readonly unknownResultRefs: MessageRef[];
}

export function purgeRepeatedOldErrors(
  messages: readonly StoredMessage[],
  range: CompressionRange,
): PurgedRepeatedErrorGroup[] {
  const groups = new Map<string, { toolName: string; entries: Array<{ ref: MessageRef; part: ErrorToolPart }> }>();

  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const ref = `m${String(index + 1).padStart(4, "0")}` as MessageRef;
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state !== "error") continue;
      const key = normalizedErrorKey(part);
      const group = groups.get(key) ?? { toolName: part.toolName, entries: [] };
      group.entries.push({ ref, part });
      groups.set(key, group);
    }
  }

  return [...groups.entries()]
    .map(([key, group]) => toPurgedGroup(key, group))
    .filter((group) => group.collapsedRefs.length > 0 || group.unknownResultRefs.length > 0);
}

function toPurgedGroup(
  key: string,
  group: { toolName: string; entries: Array<{ ref: MessageRef; part: ErrorToolPart }> },
): PurgedRepeatedErrorGroup {
  const unknownResultRefs = group.entries
    .filter(({ part }) => part.result.details?.unknownResult === true)
    .map(({ ref }) => ref);
  const actionable = group.entries.filter(({ part }) => part.result.details?.unknownResult !== true);
  const preservedActionable = actionable.at(-1);
  const collapsedRefs = preservedActionable === undefined
    ? []
    : actionable.slice(0, -1).map(({ ref }) => ref);
  const preservedRefs = [
    ...unknownResultRefs,
    ...(preservedActionable === undefined ? [] : [preservedActionable.ref]),
  ];

  return { key, toolName: group.toolName, preservedRefs, collapsedRefs, unknownResultRefs };
}

function normalizedErrorKey(part: ErrorToolPart): string {
  return JSON.stringify({
    toolName: part.toolName,
    input: normalizeValue(part.input),
    preview: normalizeText(part.result.output.preview),
    error: part.result.details?.error,
    recovery: part.result.output.recovery,
  });
}
