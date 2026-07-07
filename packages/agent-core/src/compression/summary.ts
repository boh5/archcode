import { COMPRESSION_SUMMARY_FORMAT_VERSION, COMPRESSION_SUMMARY_SECTION_NAMES } from "./constants";
import type { BlockRef, CompressionSummary, CompressionSummarySectionName } from "./types";

export interface CompressionSummarySchemaContract {
  readonly version: typeof COMPRESSION_SUMMARY_FORMAT_VERSION;
  readonly requiredSections: readonly CompressionSummarySectionName[];
  readonly strict: true;
}

export const CompressionSummarySchema: CompressionSummarySchemaContract = {
  version: COMPRESSION_SUMMARY_FORMAT_VERSION,
  requiredSections: COMPRESSION_SUMMARY_SECTION_NAMES,
  strict: true,
};

export interface SummaryValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
}

export function validateCompressionSummary(
  summary: unknown,
  requiredChildRefs: readonly BlockRef[] = [],
): SummaryValidationResult {
  const parsed = parseCompressionSummary(summary);
  if (!parsed.ok) return parsed;

  const errors = validateChildPlaceholders(parsed.summary, requiredChildRefs);
  return { ok: errors.length === 0, errors };
}

export function assertValidCompressionSummary(
  summary: unknown,
  requiredChildRefs: readonly BlockRef[] = [],
): asserts summary is CompressionSummary {
  const result = validateCompressionSummary(summary, requiredChildRefs);
  if (!result.ok) {
    throw new CompressionSummaryValidationError(result.errors);
  }
}

export class CompressionSummaryValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`Invalid compression summary: ${errors.join("; ")}`);
    this.name = "CompressionSummaryValidationError";
  }
}

export function renderCompressionSummary(summary: CompressionSummary): string {
  return COMPRESSION_SUMMARY_SECTION_NAMES
    .map((section) => `## ${section}\n${summary.sections[section]}`)
    .join("\n\n");
}

function validateChildPlaceholders(
  summary: CompressionSummary,
  requiredChildRefs: readonly BlockRef[],
): string[] {
  const errors: string[] = [];
  const uniqueRequiredRefs = [...new Set(requiredChildRefs)];
  const requiredRefs = new Set(uniqueRequiredRefs);
  const declaredRefs = new Set(summary.childBlockRefs);
  if (declaredRefs.size !== summary.childBlockRefs.length) {
    errors.push("Child Block Refs must not contain duplicates");
  }

  const rendered = renderCompressionSummary(summary);
  for (const ref of declaredRefs) {
    if (!requiredRefs.has(ref)) {
      errors.push(`Child Block Refs must not include unknown ref ${ref}`);
    }
  }

  for (const ref of extractBlockPlaceholders(rendered)) {
    if (!declaredRefs.has(ref) || !requiredRefs.has(ref)) {
      errors.push(`Placeholder (${ref}) is not a required declared child block ref`);
    }
  }

  for (const ref of uniqueRequiredRefs) {
    if (!declaredRefs.has(ref)) {
      errors.push(`Child Block Refs must include ${ref}`);
    }
    const count = countPlaceholder(rendered, ref);
    if (count !== 1) {
      errors.push(`Placeholder (${ref}) must appear exactly once; found ${count}`);
    }
  }

  return errors;
}

function parseCompressionSummary(
  value: unknown,
): { ok: true; summary: CompressionSummary } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Summary must be an object"] };
  }

  const allowedTopLevel = new Set(["version", "sections", "childBlockRefs"]);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) errors.push(`Unknown summary field ${key}`);
  }

  if (value.version !== COMPRESSION_SUMMARY_FORMAT_VERSION) {
    errors.push(`Summary version must be ${COMPRESSION_SUMMARY_FORMAT_VERSION}`);
  }

  if (!Array.isArray(value.childBlockRefs)) {
    errors.push("childBlockRefs must be an array");
  } else {
    for (const ref of value.childBlockRefs) {
      if (typeof ref !== "string" || !/^b\d+$/.test(ref)) {
        errors.push(`Invalid child block ref ${String(ref)}`);
      }
    }
  }

  if (!isRecord(value.sections)) {
    errors.push("sections must be an object");
  } else {
    const required = new Set<string>(COMPRESSION_SUMMARY_SECTION_NAMES);
    for (const section of COMPRESSION_SUMMARY_SECTION_NAMES) {
      const content = value.sections[section];
      if (typeof content !== "string" || content.length === 0) {
        errors.push(`Missing required summary section ${section}`);
      }
    }
    for (const key of Object.keys(value.sections)) {
      if (!required.has(key)) errors.push(`Unknown summary section ${key}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, summary: value as unknown as CompressionSummary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countPlaceholder(text: string, ref: BlockRef): number {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`\\(${escaped}\\)`, "g"))?.length ?? 0;
}

function extractBlockPlaceholders(text: string): BlockRef[] {
  return [...text.matchAll(/\((b\d+)\)/g)].map((match) => match[1] as BlockRef);
}
