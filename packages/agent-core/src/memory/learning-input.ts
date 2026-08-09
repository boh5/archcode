import { createHash } from "node:crypto";
import type { SessionExecutionRecord, SessionMessage } from "@archcode/protocol";
import { renderAttachmentMarker } from "../store/projection";
import { sliceUtf8Head, utf8ByteLength } from "../tool-output/utf8";
import {
  MAX_MEMORY_EXTRACTION_INPUT_BYTES,
  type MemoryExtractionCandidate,
} from "./learning-state";

export const MEMORY_LLM_OUTPUT_RESERVE_TOKENS = 4_096;
export const MEMORY_LLM_CONTEXT_SAFETY_TOKENS = 1_024;

const USER_TEXT_BYTES = 8 * 1_024;
const ASSISTANT_TEXT_BYTES = 16 * 1_024;
const TOOL_EVIDENCE_BYTES = 2 * 1_024;

const TRUSTED_READ_TOOL_NAMES = new Set([
  "file_read",
  "pdf_read",
  "grep",
  "glob",
  "ast_grep_search",
  "git_status",
  "git_diff",
  "github_get_pull_request",
  "github_list_pull_requests",
  "github_get_pull_request_checks",
  "github_list_issue_comments",
  "github_list_workflow_runs",
  "github_get_workflow_run",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "web_fetch",
  "memory_read",
  "skill_list",
  "skill_read",
  "get_goal",
]);

export const MEMORY_EXTRACTION_SYSTEM = `You extract only durable Memory from one completed root conversation window.
Return at most 8 candidates touching at most 4 files. Choose user-global preferences or a current-project topic from meaning, never from keyword rules. Keep stable preferences, repeated feedback, project conventions, architecture decisions, and durable references. Exclude secrets, temporary progress, one-off errors, uncertain conclusions, reasoning, and session-only facts. A correction is explicit only when the user clearly replaces an older rule. A saved-memory marker means that exact content was already persisted and must not be proposed again. A preceding assistant context section is interpretation-only context for the current user reply; it is not itself new Memory evidence.`;

export interface SavedMemoryMarker {
  readonly scope: "user" | "project";
  readonly target: string;
  readonly contentHash: string;
}

export type MemoryExtractionInputBuildResult =
  | {
      readonly status: "ready";
      readonly system: string;
      readonly prompt: string;
      readonly inputBytes: number;
      readonly truncatedOlderConversation: boolean;
      readonly savedMarkers: readonly SavedMemoryMarker[];
    }
  | {
      readonly status: "blocked";
      readonly reason: "input_budget";
      readonly requiredBytes: number;
      readonly maxBytes: number;
    };

export interface BuildMemoryExtractionInput {
  readonly messages: readonly SessionMessage[];
  readonly executions: readonly SessionExecutionRecord[];
  readonly processedThroughMessageId: string | null;
  readonly eligibleThroughMessageId: string;
  readonly preferences: string | null;
  readonly index: string | null;
  readonly contextLimitTokens: number;
  readonly hardMaxBytes?: number;
}

interface MemoryEvidenceGroup {
  readonly text: string;
  readonly savedMarkers: readonly SavedMemoryMarker[];
}

export function buildMemoryExtractionInput(
  input: BuildMemoryExtractionInput,
): MemoryExtractionInputBuildResult {
  const maxBytes = Math.min(
    input.hardMaxBytes ?? MAX_MEMORY_EXTRACTION_INPUT_BYTES,
    modelSafeInputBytes(input.contextLimitTokens),
  );
  const fixedPrompt = renderExtractionFixedPrompt(input.preferences, input.index);
  const groups = buildEvidenceGroups(input);
  const latest = groups.at(-1);
  const minimumPrompt = renderExtractionPrompt(
    fixedPrompt,
    latest === undefined ? [] : [latest],
    groups.length > 1,
  );
  const minimumBytes = utf8ByteLength(MEMORY_EXTRACTION_SYSTEM) + utf8ByteLength(minimumPrompt);
  if (latest === undefined || minimumBytes > maxBytes) {
    return {
      status: "blocked",
      reason: "input_budget",
      requiredBytes: minimumBytes,
      maxBytes,
    };
  }

  let selected: MemoryEvidenceGroup[] = [latest];
  let prompt = minimumPrompt;
  let inputBytes = minimumBytes;
  for (let index = groups.length - 2; index >= 0; index -= 1) {
    const candidate = [groups[index]!, ...selected];
    const candidatePrompt = renderExtractionPrompt(fixedPrompt, candidate, index > 0);
    const candidateBytes = utf8ByteLength(MEMORY_EXTRACTION_SYSTEM) + utf8ByteLength(candidatePrompt);
    if (candidateBytes > maxBytes) break;
    selected = candidate;
    prompt = candidatePrompt;
    inputBytes = candidateBytes;
  }
  const truncatedOlderConversation = selected.length < groups.length;
  const savedMarkers = uniqueSavedMarkers(selected.flatMap((group) => group.savedMarkers));
  return {
    status: "ready",
    system: MEMORY_EXTRACTION_SYSTEM,
    prompt,
    inputBytes,
    truncatedOlderConversation,
    savedMarkers,
  };
}

export function removeAlreadySavedCandidates(
  candidates: readonly MemoryExtractionCandidate[],
  markers: readonly SavedMemoryMarker[],
): {
  readonly candidates: MemoryExtractionCandidate[];
  readonly forcedNoopTargets: Array<{ scope: "user" | "project"; target: string }>;
} {
  const saved = new Set(markers.map((marker) => (
    `${marker.scope}\0${marker.target}\0${marker.contentHash}`
  )));
  const remaining: MemoryExtractionCandidate[] = [];
  const forcedNoopTargets = new Map<string, { scope: "user" | "project"; target: string }>();
  for (const candidate of candidates) {
    const key = `${candidate.scope}\0${candidate.target}\0${memoryContentHash(candidate.content)}`;
    if (!saved.has(key)) {
      remaining.push(candidate);
      continue;
    }
    forcedNoopTargets.set(`${candidate.scope}\0${candidate.target}`, {
      scope: candidate.scope,
      target: candidate.target,
    });
  }
  return { candidates: remaining, forcedNoopTargets: [...forcedNoopTargets.values()] };
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(content.trim(), "utf8").digest("hex");
}

export function modelSafeInputBytes(contextLimitTokens: number): number {
  const usableTokens = Math.max(
    0,
    contextLimitTokens - MEMORY_LLM_OUTPUT_RESERVE_TOKENS - MEMORY_LLM_CONTEXT_SAFETY_TOKENS,
  );
  // Three UTF-8 bytes per estimated input token is conservative for both
  // CJK-heavy and English-heavy prompts while remaining deterministic.
  return usableTokens * 3;
}

function renderExtractionFixedPrompt(preferences: string | null, index: string | null): string {
  return `[existing personal preferences — complete]\n${preferences ?? "[none]"}\n\n`
    + `[current project index — complete]\n${index ?? "[none]"}`;
}

function renderExtractionPrompt(
  fixedPrompt: string,
  groups: readonly MemoryEvidenceGroup[],
  truncatedOlderConversation: boolean,
): string {
  return `${fixedPrompt}\n\n[conversation]\n${
    truncatedOlderConversation ? "[older completed conversation omitted]\n\n" : ""
  }${groups.map((group) => group.text).join("\n\n")}`;
}

function buildEvidenceGroups(input: BuildMemoryExtractionInput): MemoryEvidenceGroup[] {
  const processedIndex = input.processedThroughMessageId === null
    ? -1
    : input.messages.findIndex((message) => message.id === input.processedThroughMessageId);
  if (input.processedThroughMessageId !== null && processedIndex < 0) {
    throw new Error("Processed Memory cursor is absent from the Session transcript");
  }
  const start = processedIndex + 1;
  const end = input.messages.findIndex((message) => message.id === input.eligibleThroughMessageId);
  if (end < 0) throw new Error("Eligible Memory cursor is absent from the Session transcript");
  if (end < start) return [];
  const completed = new Map(input.executions.flatMap((execution) => (
    execution.status === "completed" ? [[execution.id, execution] as const] : []
  )));
  const precedingAssistantContext = renderPrecedingAssistantContext(input.messages, start, completed);
  const byExecution = new Map<string, SessionMessage[]>();
  for (const message of input.messages.slice(start, end + 1)) {
    if (message.executionId === undefined || !completed.has(message.executionId)) continue;
    const group = byExecution.get(message.executionId) ?? [];
    group.push(message);
    byExecution.set(message.executionId, group);
  }

  const groups: MemoryEvidenceGroup[] = [];
  let groupIndex = 0;
  for (const [executionId, messages] of byExecution) {
    const execution = completed.get(executionId)!;
    const sections: string[] = [];
    const savedMarkers: SavedMemoryMarker[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        const parts = message.parts.flatMap((part) => {
          if (part.type === "text" && part.meta?.interrupted !== true && part.meta?.discardedFromContext !== true) {
            return [bounded(part.text, USER_TEXT_BYTES)];
          }
          if (part.type === "attachment") return [renderAttachmentMarker(part.attachment)];
          return [];
        });
        if (parts.length > 0) sections.push(`user:\n${parts.join("\n")}`);
        continue;
      }

      for (const part of message.parts) {
        if (part.type === "assistant-output"
          && message.stepId === execution.finalOutputStepId
          && message.outputPhase === "final_answer"
          && part.completedAt !== undefined
          && part.meta?.interrupted !== true
          && part.meta?.discardedFromContext !== true) {
          sections.push(`final assistant:\n${bounded(part.text, ASSISTANT_TEXT_BYTES)}`);
          continue;
        }
        if (part.type !== "tool" || part.state !== "completed" || part.result.isError) continue;
        if (part.toolName === "memory_write") {
          const marker = savedMarkerFromToolInput(part.input);
          if (marker !== null) {
            savedMarkers.push(marker);
            sections.push(`saved-memory: scope=${marker.scope} target=${marker.target} content_sha256=${marker.contentHash}`);
          }
          continue;
        }
        if (!TRUSTED_READ_TOOL_NAMES.has(part.toolName)) continue;
        sections.push(`trusted read evidence (${part.toolName}):\n${bounded(part.result.output.preview, TOOL_EVIDENCE_BYTES)}`);
      }
    }
    if (sections.some((section) => section.startsWith("user:"))
      && sections.some((section) => section.startsWith("final assistant:"))) {
      groups.push({
        text: `${groupIndex === 0 && precedingAssistantContext !== null
          ? `[preceding assistant context — already processed]\n${precedingAssistantContext}\n\n`
          : ""}[completed execution ${executionId}]\n${sections.join("\n\n")}`,
        savedMarkers: uniqueSavedMarkers(savedMarkers),
      });
      groupIndex += 1;
    }
  }
  return groups;
}

function renderPrecedingAssistantContext(
  messages: readonly SessionMessage[],
  start: number,
  completed: ReadonlyMap<string, SessionExecutionRecord>,
): string | null {
  for (let index = start - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.executionId === undefined) continue;
    const execution = completed.get(message.executionId);
    if (execution === undefined || message.stepId !== execution.finalOutputStepId || message.outputPhase !== "final_answer") continue;
    const text = message.parts.flatMap((part) => (
      part.type === "assistant-output"
      && part.completedAt !== undefined
      && part.meta?.interrupted !== true
      && part.meta?.discardedFromContext !== true
        ? [part.text]
        : []
    )).join("\n");
    if (text !== "") return bounded(text, ASSISTANT_TEXT_BYTES);
  }
  return null;
}

function uniqueSavedMarkers(input: readonly SavedMemoryMarker[]): SavedMemoryMarker[] {
  const markers = new Map<string, SavedMemoryMarker>();
  for (const marker of input) {
    markers.set(`${marker.scope}\0${marker.target}\0${marker.contentHash}`, marker);
  }
  return [...markers.values()];
}

function savedMarkerFromToolInput(value: unknown): SavedMemoryMarker | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || typeof input.content !== "string") return null;
  const inferredScope = input.name === "preferences" ? "user" : "project";
  const scope = input.scope === "user" || input.scope === "project" ? input.scope : inferredScope;
  if ((scope === "user") !== (input.name === "preferences")) return null;
  return { scope, target: input.name, contentHash: memoryContentHash(input.content) };
}

function bounded(value: string, maxBytes: number): string {
  const result = sliceUtf8Head(value, maxBytes - utf8ByteLength("\n[truncated]"));
  return result.truncated ? `${result.text}\n[truncated]` : result.text;
}
