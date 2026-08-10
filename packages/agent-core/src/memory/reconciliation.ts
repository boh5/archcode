import type { MemoryTopicType } from "./types";
import { utf8ByteLength } from "../tool-output/utf8";
import { containsSecretPattern } from "../security/patterns";
import {
  MAX_MEMORY_RECONCILIATION_INPUT_BYTES,
  type MemoryExtractionCandidate,
  type MemoryReconciliationOperation,
} from "./learning-state";
import { modelSafeInputBytes } from "./learning-input";

const CANONICAL_BLOCK_DIVIDER = "\n\n---\n\n";

export const MEMORY_RECONCILIATION_SYSTEM = `Reconcile durable Memory candidates against the complete selected files.
Return exactly one ADD, UPDATE, or NOOP operation for every target. Use NOOP for exact or semantic duplicates. ADD only durable new information. UPDATE only when an explicit user correction replaces or merges the cited numbered blocks; inferred uncertainty must never overwrite existing Memory. Do not delete unrelated content, invent targets, or change any file not supplied.`;

export interface MemoryReconciliationTarget {
  readonly scope: "user" | "project";
  readonly name: string;
  /** Mutable preferences document or parsed topic body. */
  readonly document: string;
  /** Exact complete topic file. Its frontmatter is immutable during reconciliation. */
  readonly rawDocument?: string;
  readonly exists: boolean;
  readonly topic?: {
    readonly title: string;
    readonly description: string;
    readonly type: MemoryTopicType;
  };
}

export type MemoryReconciliationInputBuildResult =
  | {
      readonly status: "ready";
      readonly system: string;
      readonly prompt: string;
      readonly inputBytes: number;
    }
  | {
      readonly status: "blocked";
      readonly reason: "reconciliation_budget";
      readonly requiredBytes: number;
      readonly maxBytes: number;
    };

export function filterUnsafeMemoryCandidates(
  candidates: readonly MemoryExtractionCandidate[],
): MemoryExtractionCandidate[] {
  return candidates.filter((candidate) => {
    const persistentFields = candidate.scope === "project"
      ? [candidate.target, candidate.title, candidate.description, candidate.type, candidate.content]
      : [candidate.target, candidate.content];
    return persistentFields.every((field) => !containsSecretPattern(field).found);
  });
}

export function buildMemoryReconciliationInput(input: {
  readonly candidates: readonly MemoryExtractionCandidate[];
  readonly targets: readonly MemoryReconciliationTarget[];
  readonly contextLimitTokens: number;
  readonly hardMaxBytes?: number;
}): MemoryReconciliationInputBuildResult {
  const candidateTargets = new Set(input.candidates.map(candidateTargetKey));
  const suppliedTargets = new Set(input.targets.map(targetKey));
  if (candidateTargets.size !== suppliedTargets.size
    || [...candidateTargets].some((key) => !suppliedTargets.has(key))) {
    throw new Error("Reconciliation targets must exactly match extracted candidate targets");
  }
  const targetSections = input.targets.map((target) => {
    const blocks = splitMemoryBlocks(target.document);
    const rendered = blocks.length === 0
      ? "[empty target]"
      : blocks.map((block, index) => `[block ${index + 1}]\n${block}`).join("\n\n");
    const immutablePrefix = topicDocumentPrefix(target);
    return `[target scope=${target.scope} name=${target.name} exists=${target.exists}]\n`
      + `${immutablePrefix === "" ? "" : `[immutable file prefix]\n${immutablePrefix}\n`}`
      + `[mutable body]\n${rendered}`;
  });
  const candidateSection = JSON.stringify(input.candidates);
  const prompt = `[candidates]\n${candidateSection}\n\n${targetSections.join("\n\n")}`;
  const requiredBytes = utf8ByteLength(MEMORY_RECONCILIATION_SYSTEM) + utf8ByteLength(prompt);
  const maxBytes = Math.min(
    input.hardMaxBytes ?? MAX_MEMORY_RECONCILIATION_INPUT_BYTES,
    modelSafeInputBytes(input.contextLimitTokens),
  );
  if (requiredBytes > maxBytes) {
    return { status: "blocked", reason: "reconciliation_budget", requiredBytes, maxBytes };
  }
  return { status: "ready", system: MEMORY_RECONCILIATION_SYSTEM, prompt, inputBytes: requiredBytes };
}

function topicDocumentPrefix(target: MemoryReconciliationTarget): string {
  if (target.scope === "user") {
    if (target.rawDocument !== undefined) {
      throw new Error("Personal preferences must not provide a separate raw document");
    }
    return "";
  }
  if (!target.exists) {
    if (target.rawDocument !== undefined && target.rawDocument !== "") {
      throw new Error(`Missing topic ${target.name} cannot provide a raw document`);
    }
    return "";
  }
  if (target.rawDocument === undefined || !target.rawDocument.endsWith(target.document)) {
    throw new Error(`Complete topic document for ${target.name} does not match its parsed body`);
  }
  return target.rawDocument.slice(0, target.rawDocument.length - target.document.length);
}

export function applyMemoryReconciliation(input: {
  readonly candidates: readonly MemoryExtractionCandidate[];
  readonly targets: readonly MemoryReconciliationTarget[];
  readonly operations: readonly MemoryReconciliationOperation[];
  readonly forcedNoopTargets?: readonly { scope: "user" | "project"; target: string }[];
}): Map<string, string> {
  const targetMap = new Map(input.targets.map((target) => [targetKey(target), target]));
  const operationMap = new Map(input.operations.map((operation) => [operationTargetKey(operation), operation]));
  for (const forced of input.forcedNoopTargets ?? []) {
    const key = `${forced.scope}\0${forced.target}`;
    if (operationMap.has(key)) throw new Error(`Saved Memory target ${forced.target} cannot also be reconciled`);
  }
  const candidateKeys = new Set(input.candidates.map(candidateTargetKey));
  if (candidateKeys.size !== targetMap.size
    || [...candidateKeys].some((key) => !targetMap.has(key))
    || operationMap.size !== targetMap.size
    || [...operationMap].some(([key]) => !targetMap.has(key))) {
    throw new Error("Reconciliation operations must cover exactly the touched targets");
  }

  const result = new Map<string, string>();
  for (const [key, target] of targetMap) {
    const operation = operationMap.get(key)!;
    if (operation.action === "NOOP") {
      result.set(key, target.document);
      continue;
    }
    if (containsSecretPattern(operation.content).found) {
      throw new Error(`Reconciliation content for ${target.name} contains a secret pattern`);
    }
    if (operation.action === "ADD") {
      result.set(key, appendBlock(target.document, operation.content));
      continue;
    }
    if (!target.exists) throw new Error(`UPDATE cannot target missing Memory ${target.name}`);
    const explicitCorrection = input.candidates.some((candidate) => (
      candidateTargetKey(candidate) === key
      && candidate.basis === "explicit"
      && candidate.intent === "correct"
    ));
    if (!explicitCorrection) {
      throw new Error(`UPDATE for ${target.name} requires an explicit user correction`);
    }
    result.set(key, replaceBlocks(target.document, operation.blockIds, operation.content));
  }
  return result;
}

export function splitMemoryBlocks(document: string): string[] {
  if (document.length === 0) return [];
  return document.split(CANONICAL_BLOCK_DIVIDER);
}

function appendBlock(document: string, content: string): string {
  const block = content.trim();
  return document.length === 0 ? block : `${document}${CANONICAL_BLOCK_DIVIDER}${block}`;
}

function replaceBlocks(document: string, blockIds: readonly number[], content: string): string {
  const blocks = splitMemoryBlocks(document);
  const selected = new Set(blockIds);
  for (const blockId of selected) {
    if (blockId < 1 || blockId > blocks.length) {
      throw new Error(`UPDATE references missing block ${blockId}`);
    }
  }
  const first = Math.min(...selected);
  const replacement = content.trim();
  const next = blocks.flatMap((block, index) => {
    const blockId = index + 1;
    if (blockId === first) return [replacement];
    return selected.has(blockId) ? [] : [block];
  });
  return next.join(CANONICAL_BLOCK_DIVIDER);
}

function candidateTargetKey(candidate: MemoryExtractionCandidate): string {
  return `${candidate.scope}\0${candidate.target}`;
}

function targetKey(target: MemoryReconciliationTarget): string {
  return `${target.scope}\0${target.name}`;
}

function operationTargetKey(operation: MemoryReconciliationOperation): string {
  return `${operation.scope}\0${operation.target}`;
}
