import type {
  DiffFile,
  FinalizedToolResult,
  JsonObject,
  ToolOutput,
  ToolResultPresentation,
  ToolResultDetails,
} from "@archcode/protocol";
import type { AnyToolDescriptor, RawToolResult, ToolExecutionContext } from "../tools/types";
import { SecretRedactionPolicy } from "../security";
import { ToolOutputArtifactStore, computeProjectIdentity } from "./artifact-store";
import type { ToolOutputCapture } from "./capture";
import { ToolOutputError, isToolOutputError } from "./errors";
import { projectCanonicalText } from "./projection";
import { canonicalizeUtf8, countUtf8Lines, safeUtf8End, utf8ByteLength } from "./utf8";

const DETAILS_MAX_BYTES = 256 * 1024;
const MODEL_RESULT_MAX_BYTES = 50 * 1024;
const RECOVERY_MAX_BYTES = 16 * 1024;
const RECOVERY_MAX_DEPTH = 8;
const RECOVERY_MAX_KEYS = 64;
const RECOVERY_MAX_ARRAY_ITEMS = 256;
const RECOVERY_MAX_KEY_BYTES = 128;
const RECOVERY_MAX_STRING_BYTES = 8 * 1024;
const DIFF_PRESENTATION_MAX_BYTES = 256 * 1024;
const DIFF_PRESENTATION_MAX_FILES = 20;
const DIFF_PRESENTATION_MAX_LINES = 2_000;
const DIFF_TEXT_MAX_BYTES = 4 * 1024;
const ASK_PRESENTATION_MAX_BYTES = 64 * 1024;
const ASK_PRESENTATION_MAX_GROUPS = 3;
const ASK_QUESTION_MAX_BYTES = 2 * 1024;
const ASK_ANSWER_MAX_BYTES = 16 * 1024;
const ERROR_FIELD_MAX_BYTES = 128;
const ERROR_HINT_MAX_BYTES = 2 * 1024;

export interface FinalizeRawToolResultInput {
  readonly descriptor: AnyToolDescriptor;
  readonly raw: RawToolResult;
  readonly context: ToolExecutionContext;
  readonly capture?: ToolOutputCapture;
  readonly attempted: boolean;
}

export interface ToolOutputFinalizerOptions {
  readonly artifactStore: ToolOutputArtifactStore;
  readonly redactionPolicy: SecretRedactionPolicy;
}

/** The only conversion from descriptor-owned RawToolResult to the wire contract. */
export class ToolOutputFinalizer {
  readonly #artifactStore: ToolOutputArtifactStore;
  readonly #redactionPolicy: SecretRedactionPolicy;
  readonly #projectIdentities = new Map<string, Promise<string>>();

  constructor(options: ToolOutputFinalizerOptions) {
    this.#artifactStore = options.artifactStore;
    this.#redactionPolicy = options.redactionPolicy;
  }

  redactString(value: string): string {
    return this.#redactionPolicy.redactString(value);
  }

  redactValue<T>(value: T): T {
    return this.#redactionPolicy.redactValue(value);
  }

  async beginCapture(
    descriptor: AnyToolDescriptor,
    context: ToolExecutionContext,
  ): Promise<ToolOutputCapture | undefined> {
    if (descriptor.outputPolicy.kind !== "artifact") return undefined;
    const state = context.store.getState();
    return this.#artifactStore.beginCapture({
      owner: {
        projectIdentity: await this.#projectIdentity(context.projectContext.project.workspaceRoot),
        rootSessionId: state.rootSessionId,
        producerSessionId: state.sessionId,
      },
      previewDirection: descriptor.outputPolicy.previewDirection,
      redactor: this.#redactionPolicy.createStreamRedactor(),
    });
  }

  async finalize(input: FinalizeRawToolResultInput): Promise<FinalizedToolResult> {
    try {
      const details = sanitizeDetails(
        this.#redactionPolicy.redactValue(input.raw.details),
      );
      switch (input.descriptor.outputPolicy.kind) {
        case "source":
          return this.#finalizeSource(input, details);
        case "inline":
          return this.#finalizeInline(input, details);
        case "artifact":
          return await this.#finalizeArtifact(input, details);
      }
    } catch (error) {
      await input.capture?.abort().catch(() => undefined);
      return this.createSystemResult({
        isError: true,
        code: isToolOutputError(error) ? error.code : "TOOL_OUTPUT_UNAVAILABLE",
        message: isToolOutputError(error) ? error.message : "Tool output finalization failed",
        unknownResult: input.attempted,
      });
    }
  }

  createSystemResult(input: {
    readonly isError: boolean;
    readonly code: string;
    readonly message: string;
    readonly name?: string;
    readonly hint?: string;
    readonly unknownResult?: boolean;
  }): FinalizedToolResult {
    const message = this.#redactionPolicy.redactString(input.message);
    const payload = JSON.stringify({
      code: boundedText(input.code, ERROR_FIELD_MAX_BYTES),
      message,
      ...(input.hint === undefined ? {} : { hint: boundedText(this.#redactionPolicy.redactString(input.hint), ERROR_HINT_MAX_BYTES) }),
    });
    const canonical = canonicalizeUtf8(payload);
    const count = { bytes: canonical.canonicalBytes, lines: canonical.canonicalLines };
    return fitSystemResult({
      isError: input.isError,
      output: {
        preview: canonical.text,
        completeness: "complete",
        observed: count,
        canonical: count,
        stored: count,
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
      ...(input.isError || input.unknownResult
        ? {
            details: {
              ...(input.isError
                ? {
                    error: {
                      kind: "execution",
                      code: boundedText(input.code, ERROR_FIELD_MAX_BYTES),
                      name: boundedText(input.name ?? "ToolOutputError", ERROR_FIELD_MAX_BYTES),
                      ...(input.hint === undefined
                        ? {}
                        : { hint: boundedText(this.#redactionPolicy.redactString(input.hint), ERROR_HINT_MAX_BYTES) }),
                    },
                  }
                : {}),
              ...(input.unknownResult ? { unknownResult: true as const } : {}),
            },
          }
        : {}),
    });
  }

  finalizeSystemRaw(raw: RawToolResult): FinalizedToolResult {
    if (raw.draft.kind !== "text") {
      return this.createSystemResult({
        isError: true,
        code: "TOOL_OUTPUT_POLICY_VIOLATION",
        message: "System tool result must use a bounded text draft",
        unknownResult: raw.details?.unknownResult,
      });
    }
    const details = sanitizeDetails(this.#redactionPolicy.redactValue(raw.details));
    const observed = canonicalizeUtf8(raw.draft.text);
    const canonical = canonicalizeUtf8(this.#redactionPolicy.redactString(raw.draft.text));
    const projection = projectCanonicalText(canonical.bytes, "head");
    if (projection.completeness !== "complete") {
      return this.createSystemResult({
        isError: true,
        code: "TOOL_OUTPUT_POLICY_VIOLATION",
        message: "System tool result exceeded its strict output limit",
        unknownResult: raw.details?.unknownResult,
      });
    }
    const count = { bytes: canonical.canonicalBytes, lines: canonical.canonicalLines };
    return fitSystemResult({
      isError: raw.isError,
      output: {
        preview: projection.preview,
        completeness: "complete",
        observed: { bytes: observed.observedBytes, lines: observed.canonicalLines },
        canonical: count,
        stored: count,
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
      ...(details === undefined ? {} : { details }),
    });
  }

  #finalizeSource(
    input: FinalizeRawToolResultInput,
    details: ToolResultDetails | undefined,
  ): FinalizedToolResult {
    if (input.raw.draft.kind !== "source" && input.raw.draft.kind !== "text") {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const source = input.raw.draft;
    const text = source.text;
    const observed = canonicalizeUtf8(text);
    const canonical = canonicalizeUtf8(this.#redactionPolicy.redactString(text));
    const projection = projectCanonicalText(
      canonical.bytes,
      input.descriptor.outputPolicy.previewDirection,
    );
    const nextInput = source.kind === "source" ? source.nextInput : undefined;
    const recovery = nextInput === undefined
      ? { kind: "none" as const }
      : this.#validateSourceRecovery(input.descriptor, nextInput);
    if (projection.completeness === "partial" && recovery.kind === "none") {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const storedLines = countUtf8Lines(new TextEncoder().encode(projection.preview));
    return {
      isError: input.raw.isError,
      output: {
        preview: projection.preview,
        completeness: projection.completeness,
        observed: { bytes: observed.observedBytes, lines: observed.canonicalLines },
        canonical: { bytes: canonical.canonicalBytes, lines: canonical.canonicalLines },
        stored: { bytes: projection.previewBytes, lines: storedLines },
        omitted: {
          bytes: projection.omittedBytes,
          lines: Math.max(0, canonical.canonicalLines - storedLines),
        },
        recovery,
      },
      ...(details === undefined ? {} : { details }),
    };
  }

  #finalizeInline(
    input: FinalizeRawToolResultInput,
    details: ToolResultDetails | undefined,
  ): FinalizedToolResult {
    if (input.raw.draft.kind !== "text") {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const observed = canonicalizeUtf8(input.raw.draft.text);
    const canonical = canonicalizeUtf8(this.#redactionPolicy.redactString(input.raw.draft.text));
    const projection = projectCanonicalText(
      canonical.bytes,
      input.descriptor.outputPolicy.previewDirection,
    );
    if (projection.completeness !== "complete") {
      return this.createSystemResult({
        isError: true,
        code: "TOOL_OUTPUT_POLICY_VIOLATION",
        message: "Inline tool output exceeded its strict limit",
        unknownResult: input.attempted,
      });
    }
    const count = { bytes: canonical.canonicalBytes, lines: canonical.canonicalLines };
    return {
      isError: input.raw.isError,
      output: {
        preview: projection.preview,
        completeness: "complete",
        observed: { bytes: observed.observedBytes, lines: observed.canonicalLines },
        canonical: count,
        stored: count,
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
      ...(details === undefined ? {} : { details }),
    };
  }

  async #finalizeArtifact(
    input: FinalizeRawToolResultInput,
    details: ToolResultDetails | undefined,
  ): Promise<FinalizedToolResult> {
    const capture = input.capture;
    if (capture === undefined || input.context.outputCapture !== capture) {
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    }
    if (input.raw.draft.kind === "source") {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    if (input.raw.draft.kind === "text") {
      await capture.write(input.raw.draft.text);
    }
    const completed = await capture.complete();
    const created = completed.artifactRequired
      ? await capture.commit(completed)
      : undefined;
    if (created === undefined) await capture.discard(completed);
    const output: ToolOutput = {
      preview: completed.projection.preview,
      completeness: completed.projection.completeness,
      observed: completed.observed,
      canonical: completed.canonical,
      stored: completed.stored,
      omitted: completed.omitted,
      recovery: created === undefined
        ? { kind: "none" }
        : {
            kind: "artifact",
            outputRef: created.outputRef,
            expiresAt: created.metadata.expiresAt,
            canRead: true,
            canSearch: true,
          },
    };
    return {
      isError: input.raw.isError,
      output,
      ...(details === undefined ? {} : { details }),
    };
  }

  #validateSourceRecovery(
    descriptor: AnyToolDescriptor,
    nextInput: JsonObject,
  ): Extract<ToolOutput["recovery"], { kind: "source" }> {
    const redacted = this.#redactionPolicy.redactValue(nextInput);
    if (!isBoundedRecoveryValue(redacted)) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const parsed = descriptor.inputSchema.safeParse(redacted);
    if (!parsed.success || !isJsonObject(parsed.data)) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    return { kind: "source", toolName: descriptor.name, nextInput: parsed.data };
  }

  #projectIdentity(workspaceRoot: string): Promise<string> {
    let identity = this.#projectIdentities.get(workspaceRoot);
    if (identity === undefined) {
      identity = computeProjectIdentity(workspaceRoot);
      this.#projectIdentities.set(workspaceRoot, identity);
    }
    return identity;
  }
}

function sanitizeDetails(
  details: ToolResultDetails | undefined,
): ToolResultDetails | undefined {
  if (details === undefined) return undefined;
  const sanitized: ToolResultDetails = {
    ...(details?.error === undefined
      ? {}
      : {
          error: {
            kind: boundedText(details.error.kind, ERROR_FIELD_MAX_BYTES),
            code: boundedText(details.error.code, ERROR_FIELD_MAX_BYTES),
            name: boundedText(details.error.name, ERROR_FIELD_MAX_BYTES),
            ...(details.error.hint === undefined ? {} : { hint: boundedText(details.error.hint, ERROR_HINT_MAX_BYTES) }),
          },
        }),
    ...(details?.process === undefined ? {} : { process: sanitizeProcessDetails(details.process) }),
    ...(details.unknownResult ? { unknownResult: true as const } : {}),
  };
  if (details.presentations !== undefined && details.presentations.length > 0) {
    const presentations: ToolResultPresentation[] = [];
    const candidates = details.presentations.slice(0, 2);
    for (let index = 0; index < candidates.length; index += 1) {
      const presentation = candidates[index]!;
      const baseBytes = utf8ByteLength(JSON.stringify({ ...sanitized, presentations }));
      const available = Math.max(0, DETAILS_MAX_BYTES - baseBytes - 32);
      if (available === 0) break;
      presentations.push(sanitizePresentation(
        presentation,
        available,
        details.presentations.length > 2 && index === candidates.length - 1,
      ));
    }
    if (presentations.length > 0) sanitized.presentations = presentations;
  }
  if (utf8ByteLength(JSON.stringify(sanitized)) > DETAILS_MAX_BYTES) throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function sanitizePresentation(
  presentation: ToolResultPresentation,
  availableBytes: number,
  forceTruncated: boolean,
): ToolResultPresentation {
  return presentation.kind === "diff"
    ? sanitizeDiffPresentation(presentation.files, Math.min(availableBytes, DIFF_PRESENTATION_MAX_BYTES), forceTruncated || presentation.truncated === true)
    : sanitizeAskPresentation(presentation.answers, Math.min(availableBytes, ASK_PRESENTATION_MAX_BYTES), forceTruncated || presentation.truncated === true);
}

function sanitizeProcessDetails(
  process: NonNullable<ToolResultDetails["process"]>,
): NonNullable<ToolResultDetails["process"]> {
  if (process.exitCode !== null && (!Number.isFinite(process.exitCode) || !Number.isInteger(process.exitCode))) {
    throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
  }
  if (process.signal !== null && typeof process.signal !== "string") {
    throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
  }
  if (typeof process.timedOut !== "boolean" || typeof process.aborted !== "boolean") {
    throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
  }
  if (!Number.isFinite(process.durationMs) || process.durationMs < 0) {
    throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
  }
  return {
    exitCode: process.exitCode,
    signal: process.signal === null ? null : boundedText(process.signal, 32),
    timedOut: process.timedOut,
    aborted: process.aborted,
    durationMs: process.durationMs,
  };
}

function sanitizeDiffPresentation(
  sourceFiles: readonly DiffFile[],
  maxBytes: number,
  initiallyTruncated: boolean,
): Extract<ToolResultPresentation, { kind: "diff" }> {
  let truncated = initiallyTruncated || sourceFiles.length > DIFF_PRESENTATION_MAX_FILES;
  let lineCount = 0;
  const files: DiffFile[] = [];
  for (const sourceFile of sourceFiles.slice(0, DIFF_PRESENTATION_MAX_FILES)) {
    const file: DiffFile = {
      path: boundedText(sourceFile.path, DIFF_TEXT_MAX_BYTES),
      ...(sourceFile.status === undefined ? {} : { status: sourceFile.status }),
      ...(sourceFile.additions === undefined ? {} : { additions: sourceFile.additions }),
      ...(sourceFile.deletions === undefined ? {} : { deletions: sourceFile.deletions }),
      hunks: [],
    };
    if (file.path !== sourceFile.path) truncated = true;
    for (const sourceHunk of sourceFile.hunks) {
      if (lineCount >= DIFF_PRESENTATION_MAX_LINES) {
        truncated = true;
        break;
      }
      const lines = sourceHunk.lines
        .slice(0, DIFF_PRESENTATION_MAX_LINES - lineCount)
        .map((line) => {
          const content = boundedText(line.content, DIFF_TEXT_MAX_BYTES);
          if (content !== line.content) truncated = true;
          return { type: line.type, content };
        });
      if (lines.length < sourceHunk.lines.length) truncated = true;
      lineCount += lines.length;
      const header = boundedText(sourceHunk.header, DIFF_TEXT_MAX_BYTES);
      if (header !== sourceHunk.header) truncated = true;
      file.hunks.push({
        header,
        oldStart: sourceHunk.oldStart,
        oldLines: sourceHunk.oldLines,
        newStart: sourceHunk.newStart,
        newLines: sourceHunk.newLines,
        lines,
      });
    }
    files.push(file);
    if (lineCount >= DIFF_PRESENTATION_MAX_LINES) break;
  }

  let result: Extract<ToolResultPresentation, { kind: "diff" }> = {
    kind: "diff",
    files,
    ...(truncated ? { truncated: true } : {}),
  };
  while (utf8ByteLength(JSON.stringify(result)) > maxBytes && removeLastDiffUnit(files)) {
    truncated = true;
    result = { kind: "diff", files, truncated: true };
  }
  if (utf8ByteLength(JSON.stringify(result)) > maxBytes) {
    return { kind: "diff", files: [], truncated: true };
  }
  return result;
}

function removeLastDiffUnit(files: DiffFile[]): boolean {
  const file = files.at(-1);
  if (file === undefined) return false;
  const hunk = file.hunks.at(-1);
  if (hunk?.lines.length) {
    hunk.lines.pop();
    return true;
  }
  if (hunk !== undefined) {
    file.hunks.pop();
    return true;
  }
  files.pop();
  return true;
}

function sanitizeAskPresentation(
  sourceAnswers: Extract<ToolResultPresentation, { kind: "ask_user" }>["answers"],
  maxBytes: number,
  initiallyTruncated: boolean,
): Extract<ToolResultPresentation, { kind: "ask_user" }> {
  let truncated = initiallyTruncated || sourceAnswers.length > ASK_PRESENTATION_MAX_GROUPS;
  const answers = sourceAnswers.slice(0, ASK_PRESENTATION_MAX_GROUPS).map((group) => {
    const question = boundedText(group.question, ASK_QUESTION_MAX_BYTES);
    if (question !== group.question) truncated = true;
    return {
      question,
      answers: group.answers.map((answer) => {
        const bounded = boundedText(answer, ASK_ANSWER_MAX_BYTES);
        if (bounded !== answer) truncated = true;
        return bounded;
      }),
    };
  });
  let result: Extract<ToolResultPresentation, { kind: "ask_user" }> = {
    kind: "ask_user",
    answers,
    ...(truncated ? { truncated: true } : {}),
  };
  while (utf8ByteLength(JSON.stringify(result)) > maxBytes && removeLastAskUnit(answers)) {
    truncated = true;
    result = { kind: "ask_user", answers, truncated: true };
  }
  if (utf8ByteLength(JSON.stringify(result)) > maxBytes) {
    return { kind: "ask_user", answers: [], truncated: true };
  }
  return result;
}

function removeLastAskUnit(
  answers: Array<{ question: string; answers: string[] }>,
): boolean {
  const group = answers.at(-1);
  if (group === undefined) return false;
  if (group.answers.length > 0) {
    group.answers.pop();
    return true;
  }
  answers.pop();
  return true;
}

function isBoundedRecoveryValue(value: unknown): value is JsonObject {
  let keyCount = 0;
  let arrayItemCount = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > RECOVERY_MAX_DEPTH) return false;
    if (candidate === null || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate === "string") return utf8ByteLength(candidate) <= RECOVERY_MAX_STRING_BYTES;
    if (Array.isArray(candidate)) {
      arrayItemCount += candidate.length;
      return arrayItemCount <= RECOVERY_MAX_ARRAY_ITEMS
        && candidate.every((item) => visit(item, depth + 1));
    }
    if (candidate === null || typeof candidate !== "object") return false;
    for (const [key, nested] of Object.entries(candidate)) {
      keyCount += 1;
      if (keyCount > RECOVERY_MAX_KEYS || utf8ByteLength(key) > RECOVERY_MAX_KEY_BYTES) return false;
      if (!visit(nested, depth + 1)) return false;
    }
    return true;
  };
  return isJsonObject(value)
    && visit(value, 0)
    && utf8ByteLength(JSON.stringify(value)) <= RECOVERY_MAX_BYTES;
}

function fitSystemResult(result: FinalizedToolResult): FinalizedToolResult {
  if (utf8ByteLength(JSON.stringify(result)) <= MODEL_RESULT_MAX_BYTES) return result;
  const bytes = new TextEncoder().encode(result.output.preview);
  let low = 0;
  let high = bytes.byteLength;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const preview = new TextDecoder().decode(
      bytes.subarray(0, safeUtf8End(bytes, middle)),
    );
    const candidate = { ...result, output: { ...result.output, preview } };
    if (utf8ByteLength(JSON.stringify(candidate)) <= MODEL_RESULT_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  const preview = new TextDecoder().decode(
    bytes.subarray(0, safeUtf8End(bytes, low)),
  );
  return { ...result, output: { ...result.output, preview } };
}

function boundedText(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const bytes = new TextEncoder().encode(value);
  return new TextDecoder().decode(bytes.subarray(0, safeUtf8End(bytes, maxBytes)));
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
