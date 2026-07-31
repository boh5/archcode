import { COMPRESSION_SUMMARY_SECTION_NAMES } from "./constants";
import {
  isMaterializedCompressionSummarySnapshot,
  renderCompressionSummarySnapshot,
} from "@archcode/protocol";
import type {
  BlockRef,
  CompressionState,
  CompressionSummary,
  CompressionSummarySections,
  CompressionSummaryTemplate,
} from "./types";

export interface SummaryValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
}

interface MaterializedChildSummary {
  readonly ref: BlockRef;
  readonly rendered: string;
}

const CHILD_SUMMARY_OPEN = '<compression-child ref="';
const CHILD_SUMMARY_CLOSE = "</compression-child>";
const CHILD_SUMMARY_TAG_PATTERN = /<compression-child ref="(b\d+)">|<\/compression-child>/g;
const CHILD_SUMMARY_RESERVED_OPEN_PATTERN = /<compression-child\b/g;
const CHILD_SUMMARY_RESERVED_CLOSE_PATTERN = /<\/compression-child\b/g;

export function validateCompressionSummary(summary: unknown): SummaryValidationResult {
  const parsed = parseCompressionSummary(summary);
  if (!parsed.ok) return parsed;

  const unresolved = extractBlockPlaceholders(renderCompressionSummary(parsed.summary));
  if (!isMaterializedCompressionSummarySnapshot(parsed.summary)) {
    return {
      ok: false,
      errors: [`Stored compression summary contains unresolved placeholder (${unresolved[0]})`],
    };
  }

  const materializedChildren = parseMaterializedChildSummaries(renderCompressionSummary(parsed.summary));
  return materializedChildren.errors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: materializedChildren.errors };
}

export function validateCompressionSummaryTemplate(
  summary: unknown,
  requiredChildRefs: readonly BlockRef[] = [],
): SummaryValidationResult {
  const parsed = parseCompressionSummary(summary);
  if (!parsed.ok) return parsed;

  const rendered = renderCompressionSummary(parsed.summary);
  if (CHILD_SUMMARY_RESERVED_OPEN_PATTERN.test(rendered) || CHILD_SUMMARY_RESERVED_CLOSE_PATTERN.test(rendered)) {
    CHILD_SUMMARY_RESERVED_OPEN_PATTERN.lastIndex = 0;
    CHILD_SUMMARY_RESERVED_CLOSE_PATTERN.lastIndex = 0;
    return {
      ok: false,
      errors: ["Compression summary templates cannot contain materialized child boundaries"],
    };
  }
  CHILD_SUMMARY_RESERVED_OPEN_PATTERN.lastIndex = 0;
  CHILD_SUMMARY_RESERVED_CLOSE_PATTERN.lastIndex = 0;

  const placeholders = extractBlockPlaceholders(rendered);
  const required = new Set(requiredChildRefs);
  const errors: string[] = [];

  for (const ref of new Set(placeholders)) {
    if (!required.has(ref)) errors.push(`Placeholder (${ref}) is not a required child block ref`);
  }
  for (const ref of requiredChildRefs) {
    const occurrences = placeholders.filter((placeholder) => placeholder === ref).length;
    if (occurrences !== 1) {
      errors.push(`Required child placeholder (${ref}) must appear exactly once; found ${occurrences}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidCompressionSummary(
  summary: unknown,
): asserts summary is CompressionSummary {
  const result = validateCompressionSummary(summary);
  if (!result.ok) throw new CompressionSummaryValidationError(result.errors);
}

export function validateCompressionSummaryLineage(
  summary: unknown,
  childBlockRefs: readonly BlockRef[],
  blocksByRef: CompressionState["blocksByRef"],
): SummaryValidationResult {
  const summaryValidation = validateCompressionSummary(summary);
  if (!summaryValidation.ok) return summaryValidation;

  const parsed = parseCompressionSummary(summary);
  if (!parsed.ok) return parsed;
  const materialized = parseMaterializedChildSummaries(renderCompressionSummary(parsed.summary));
  if (materialized.errors.length > 0) return { ok: false, errors: materialized.errors };

  const errors: string[] = [];
  const expectedRefs = new Set(childBlockRefs);
  if (expectedRefs.size !== childBlockRefs.length) {
    errors.push("Compression child block refs must be unique");
  }

  const materializedByRef = new Map<BlockRef, MaterializedChildSummary[]>();
  for (const child of materialized.children) {
    const entries = materializedByRef.get(child.ref) ?? [];
    entries.push(child);
    materializedByRef.set(child.ref, entries);
    if (!expectedRefs.has(child.ref)) {
      errors.push(`Materialized summary contains undeclared child block ${child.ref}`);
    }
  }

  for (const ref of childBlockRefs) {
    const child = blocksByRef[ref];
    if (child === undefined) {
      errors.push(`Required child block ${ref} does not exist`);
      continue;
    }

    const entries = materializedByRef.get(ref) ?? [];
    if (entries.length !== 1) {
      errors.push(`Materialized child block ${ref} must appear exactly once; found ${entries.length}`);
      continue;
    }

    const expected = renderMaterializedChildSummary(ref, child.summary);
    if (entries[0]?.rendered !== expected) {
      errors.push(`Materialized child block ${ref} does not match its stored summary`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidCompressionSummaryLineage(
  summary: unknown,
  childBlockRefs: readonly BlockRef[],
  blocksByRef: CompressionState["blocksByRef"],
): asserts summary is CompressionSummary {
  const result = validateCompressionSummaryLineage(summary, childBlockRefs, blocksByRef);
  if (!result.ok) throw new CompressionSummaryValidationError(result.errors);
}

export class CompressionSummaryValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`Invalid compression summary: ${errors.join("; ")}`);
    this.name = "CompressionSummaryValidationError";
  }
}

export function renderCompressionSummary(summary: CompressionSummary): string {
  return renderCompressionSummarySnapshot(summary);
}

export function materializeCompressionSummaryTemplate(
  template: CompressionSummaryTemplate,
  requiredChildRefs: readonly BlockRef[],
  blocksByRef: CompressionState["blocksByRef"],
): CompressionSummary {
  const validation = validateCompressionSummaryTemplate(template, requiredChildRefs);
  if (!validation.ok) throw new CompressionSummaryValidationError(validation.errors);

  const childSummaries = new Map(requiredChildRefs.map((ref) => {
    const child = blocksByRef[ref];
    if (child === undefined) {
      throw new CompressionSummaryValidationError([`Required child block ${ref} does not exist`]);
    }
    return [ref, renderMaterializedChildSummary(ref, child.summary)] as const;
  }));

  const sections = Object.fromEntries(COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [
    section,
    template.sections[section].replace(/\((b\d+)\)/g, (_placeholder, rawRef: string) => (
      childSummaries.get(rawRef as BlockRef)!
    )),
  ])) as CompressionSummarySections;
  const summary = { sections };
  assertValidCompressionSummary(summary);
  assertValidCompressionSummaryLineage(summary, requiredChildRefs, blocksByRef);
  return summary;
}

export function renderMaterializedChildSummary(
  ref: BlockRef,
  summary: CompressionSummary,
): string {
  return `${CHILD_SUMMARY_OPEN}${ref}">\n${renderCompressionSummary(summary)}\n${CHILD_SUMMARY_CLOSE}`;
}

function parseCompressionSummary(
  value: unknown,
): { ok: true; summary: CompressionSummary } | { ok: false; errors: string[] } {
  if (!isRecord(value)) return { ok: false, errors: ["Summary must be an object"] };

  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "sections") errors.push(`Unknown summary field ${key}`);
  }
  errors.push(...validateSections(value.sections));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: value as unknown as CompressionSummary };
}

function validateSections(value: unknown): string[] {
  if (!isRecord(value)) return ["sections must be an object"];
  const errors: string[] = [];
  const required = new Set<string>(COMPRESSION_SUMMARY_SECTION_NAMES);
  for (const section of COMPRESSION_SUMMARY_SECTION_NAMES) {
    const content = value[section];
    if (typeof content !== "string" || content.length === 0) {
      errors.push(`Missing required summary section ${section}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.has(key)) errors.push(`Unknown summary section ${key}`);
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractBlockPlaceholders(text: string): BlockRef[] {
  return [...text.matchAll(/\((b\d+)\)/g)].map((match) => match[1] as BlockRef);
}

function parseMaterializedChildSummaries(
  text: string,
): { readonly children: MaterializedChildSummary[]; readonly errors: string[] } {
  const children: MaterializedChildSummary[] = [];
  const errors: string[] = [];
  const stack: Array<{ readonly ref: BlockRef; readonly startIndex: number }> = [];
  let recognizedOpenTags = 0;
  let recognizedCloseTags = 0;

  for (const match of text.matchAll(CHILD_SUMMARY_TAG_PATTERN)) {
    const index = match.index;
    if (index === undefined) continue;
    const ref = match[1] as BlockRef | undefined;
    if (ref !== undefined) {
      recognizedOpenTags += 1;
      stack.push({ ref, startIndex: index });
      continue;
    }

    recognizedCloseTags += 1;
    const opening = stack.pop();
    if (opening === undefined) {
      errors.push("Materialized summary contains an unmatched child closing boundary");
      continue;
    }
    if (stack.length === 0) {
      children.push({
        ref: opening.ref,
        rendered: text.slice(opening.startIndex, index + match[0].length),
      });
    }
  }

  if (stack.length > 0) {
    errors.push("Materialized summary contains an unclosed child boundary");
  }
  const reservedOpenTags = [...text.matchAll(CHILD_SUMMARY_RESERVED_OPEN_PATTERN)].length;
  const reservedCloseTags = [...text.matchAll(CHILD_SUMMARY_RESERVED_CLOSE_PATTERN)].length;
  if (reservedOpenTags !== recognizedOpenTags) {
    errors.push("Materialized summary contains a malformed child opening boundary");
  }
  if (reservedCloseTags !== recognizedCloseTags) {
    errors.push("Materialized summary contains a malformed child closing boundary");
  }
  return { children, errors };
}
