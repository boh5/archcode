import { createHash } from "node:crypto";
import type {
  MemoryBlockedWarning,
  MemoryCapacity,
  MemoryCapacityState,
  MemoryPreferencesItem,
  MemorySnapshot,
  MemoryTopicCount,
  MemoryTopicItem,
  MemoryTopicSummary,
  MemoryTopicType,
} from "@archcode/protocol";

import { containsSecretPattern } from "../security/patterns";
import { sharedMutationQueue } from "../tools/concurrency/mutation-queue";
import {
  DEFAULT_MAX_PREFERENCES_BYTES,
  MAX_MEMORY_TOPIC_BYTES,
  MAX_MEMORY_TOPICS,
} from "./constants";
import {
  MemoryCapacityError,
  MemoryRevisionConflictError,
  MemorySecretError,
  MemoryValidationError,
} from "./errors";
import {
  formatFrontmatter,
  formatIndex,
  MemoryFileManager,
  parseFrontmatter,
  parseIndex,
} from "./file-manager";
import { MemoryFrontmatterSchema } from "./schemas";

const TOPIC_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const RESERVED_TOPIC_NAMES = new Set(["index", "preferences"]);

export interface PutMemoryPreferencesInput {
  readonly content: string;
  readonly expectedRevision: string | null;
}

export interface PutMemoryTopicInput {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly type: MemoryTopicType;
  readonly content: string;
  readonly expectedRevision: string | null;
}

export interface MemoryExplicitWriteInput {
  readonly name: string;
  readonly description?: string;
  readonly type?: MemoryTopicType;
  readonly content: string;
  readonly scope: "user" | "project";
}

export interface MemoryFinalDocumentTarget {
  readonly scope: "user" | "project";
  readonly name: string;
  readonly expectedRevision: string | null;
  readonly finalRevision: string;
  readonly finalDocument: string;
}

export interface MemoryFinalIndexDocument {
  readonly expectedRevision: string | null;
  readonly finalRevision: string;
  readonly finalDocument: string;
}

export interface MemoryDocumentTarget {
  readonly scope: "user" | "project";
  readonly name: string;
}

export interface MemoryDocumentSnapshot extends MemoryDocumentTarget {
  readonly document: string | null;
  readonly revision: string | null;
}

export type MemoryChangeListener = (target: MemoryDocumentTarget) => void | Promise<void>;

export interface MemoryApplyResult {
  readonly applied: number;
  readonly alreadyApplied: number;
  readonly indexRevision: string | null;
}

export interface MemoryPromptManifest {
  readonly preferences: MemoryPreferencesItem | null;
  readonly index: MemoryIndexProjection;
}

/** Generated index metadata that never requires reading topic bodies. */
export interface MemoryIndexProjection {
  readonly content: string | null;
  readonly revision: string | null;
  readonly topicCount: MemoryTopicCount;
  readonly availableForPrompt: boolean;
}

interface CurrentTarget {
  readonly target: MemoryFinalDocumentTarget;
  readonly alreadyApplied: boolean;
}

/**
 * The sole business mutation boundary for Markdown Memory.
 *
 * MemoryFileManager remains a path-safe atomic file adapter. Capacity, CAS,
 * secret validation, legacy shrink-only behavior, and topic/index consistency
 * all live here so tools, HTTP routes, and automatic learning share one rule.
 */
export class MemoryService {
  readonly #files: MemoryFileManager;
  readonly #onChanged: MemoryChangeListener | undefined;

  constructor(files: MemoryFileManager, onChanged?: MemoryChangeListener) {
    this.#files = files;
    this.#onChanged = onChanged;
  }

  get projectRoot(): string {
    return this.#files.projectRoot;
  }

  get userRoot(): string {
    return this.#files.userRoot;
  }

  async snapshot(
    learningWarnings: readonly MemoryBlockedWarning[] = [],
  ): Promise<MemorySnapshot> {
    return await this.#withLanes(true, true, async () => {
      const preferences = await this.#readPreferencesUnlocked();
      const topicNames = await this.#files.listTopics();
      const topics: MemoryTopicSummary[] = [];
      for (const name of topicNames) {
        const topic = await this.#readTopicUnlocked(name);
        if (topic !== null) topics.push(toTopicSummary(topic));
      }

      const indexDocument = await this.#files.readIndex();
      const topicCount = createTopicCount(topicNames.length);
      const warnings = [
        ...capacityWarnings(preferences, topics, topicCount),
        ...learningWarnings,
      ].sort(compareWarnings);

      return {
        preferences,
        topics,
        index: {
          revision: revisionOf(indexDocument),
          bytes: utf8Bytes(indexDocument ?? ""),
          topicCount,
          availableForPrompt: topicCount.state !== "over-limit",
        },
        warnings,
      };
    });
  }

  async readPreferences(): Promise<MemoryPreferencesItem | null> {
    return await this.#withLanes(true, false, () => this.#readPreferencesUnlocked());
  }

  async readIndex(): Promise<string | null> {
    return await this.#withLanes(false, true, () => this.#files.readIndex());
  }

  async readIndexProjection(): Promise<MemoryIndexProjection> {
    return await this.#withLanes(false, true, () => this.#readIndexProjectionUnlocked());
  }

  async readPromptManifest(): Promise<MemoryPromptManifest> {
    return await this.#withLanes(true, true, async () => {
      const [preferences, index] = await Promise.all([
        this.#readPreferencesUnlocked(),
        this.#readIndexProjectionUnlocked(),
      ]);
      return { preferences, index };
    });
  }

  async readTopic(name: string): Promise<MemoryTopicItem | null> {
    assertTopicName(name);
    return await this.#withLanes(false, true, () => this.#readTopicUnlocked(name));
  }

  /** Reads complete selected documents for bounded reconciliation input. */
  async readDocuments(
    inputTargets: readonly MemoryDocumentTarget[],
  ): Promise<readonly MemoryDocumentSnapshot[]> {
    const targets = [...inputTargets].sort(compareDocumentTargets);
    assertUniqueDocumentTargets(targets);
    for (const target of targets) assertDocumentTarget(target);
    const needsUser = targets.some((target) => target.scope === "user");
    const needsProject = targets.some((target) => target.scope === "project");
    return await this.#withLanes(needsUser, needsProject, async () => {
      const snapshots: MemoryDocumentSnapshot[] = [];
      for (const target of targets) {
        const document = target.scope === "user"
          ? await this.#files.readPreferences()
          : await this.#files.readTopicDocument(target.name);
        snapshots.push({ ...target, document, revision: revisionOf(document) });
      }
      return snapshots;
    });
  }

  async putPreferences(input: PutMemoryPreferencesInput): Promise<MemoryPreferencesItem> {
    assertNoSecret(input.content);
    return await this.#withLanes(true, false, async () => {
      const current = await this.#files.readPreferences();
      assertRevision("preferences", input.expectedRevision, revisionOf(current));
      assertCapacity("preferences", input.content, current, DEFAULT_MAX_PREFERENCES_BYTES);
      await this.#files.writePreferences(input.content);
      await this.#onChanged?.({ scope: "user", name: "preferences" });
      return toPreferencesItem(input.content);
    });
  }

  async deletePreferences(input: { readonly expectedRevision: string | null }): Promise<void> {
    await this.#withLanes(true, false, async () => {
      const current = await this.#files.readPreferences();
      assertRevision("preferences", input.expectedRevision, revisionOf(current));
      await this.#files.deletePreferences();
      await this.#onChanged?.({ scope: "user", name: "preferences" });
    });
  }

  async putTopic(input: PutMemoryTopicInput): Promise<MemoryTopicItem> {
    assertTopicName(input.name);
    const document = formatValidatedTopicDocument(input.name, {
      name: input.title ?? input.name,
      description: input.description,
      type: input.type,
    }, input.content);
    assertNoSecret(document);

    return await this.#withLanes(false, true, async () => {
      const current = await this.#files.readTopicDocument(input.name);
      assertRevision(input.name, input.expectedRevision, revisionOf(current));
      await this.#assertTopicMutationAllowed(input.name, document, current);
      await this.#files.writeTopicDocument(input.name, document);
      await this.#files.rebuildIndex();
      await this.#onChanged?.({ scope: "project", name: input.name });
      return topicItemFromDocument(input.name, document);
    });
  }

  async deleteTopic(input: {
    readonly name: string;
    readonly expectedRevision: string | null;
  }): Promise<void> {
    assertTopicName(input.name);
    await this.#withLanes(false, true, async () => {
      const current = await this.#files.readTopicDocument(input.name);
      assertRevision(input.name, input.expectedRevision, revisionOf(current));
      await this.#files.deleteTopic(input.name);
      await this.#files.rebuildIndex();
      await this.#onChanged?.({ scope: "project", name: input.name });
    });
  }

  /** Preserves the existing model-facing memory_write append/upsert contract. */
  async writeExplicit(input: MemoryExplicitWriteInput): Promise<void> {
    assertNoSecret(input.content);
    if (input.scope === "user") {
      if (input.name !== "preferences") {
        throw new MemoryValidationError("Only preferences can use user scope");
      }
      await this.#withLanes(true, false, async () => {
        const current = await this.#files.readPreferences();
        const document = current !== null
          ? `${current.trimEnd()}\n\n---\n\n${input.content.trimEnd()}\n`
          : `${input.content.trimEnd()}\n`;
        assertCapacity("preferences", document, current, DEFAULT_MAX_PREFERENCES_BYTES);
        await this.#files.writePreferences(document);
        await this.#onChanged?.({ scope: "user", name: "preferences" });
      });
      return;
    }

    assertTopicName(input.name);
    assertCanonicalTopicMetadata(input.name, {
      name: input.name,
      description: input.description ?? "",
      type: input.type ?? "project",
    });
    await this.#withLanes(false, true, async () => {
      const current = await this.#files.readTopicDocument(input.name);
      const currentMetadata = current === null
        ? undefined
        : parseAndValidateTopicDocument(input.name, current).frontmatter;
      const metadata = {
        name: currentMetadata?.name ?? input.name,
        description: input.description ?? currentMetadata?.description ?? "",
        type: input.type ?? currentMetadata?.type ?? "project",
      };
      const document = formatValidatedTopicDocument(input.name, metadata, input.content);
      assertNoSecret(document);
      await this.#assertTopicMutationAllowed(input.name, document, current);
      await this.#files.writeTopicDocument(input.name, document);
      await this.#files.rebuildIndex();
      await this.#onChanged?.({ scope: "project", name: input.name });
    });
  }

  /**
   * Deterministically replays a bounded coordinator receipt without owning it.
   * All conflicts are discovered before the first write. A previously written
   * final revision is idempotent; topics are followed by one deterministic
   * index document write derived from the current index plus touched metadata.
   */
  async applyFinalDocuments(
    inputTargets: readonly MemoryFinalDocumentTarget[],
    inputIndex?: MemoryFinalIndexDocument,
  ): Promise<MemoryApplyResult> {
    const targets = [...inputTargets].sort(compareTargets);
    assertUniqueTargets(targets);
    const needsUser = targets.some((target) => target.scope === "user");
    const needsProject = targets.some((target) => target.scope === "project");

    return await this.#withLanes(needsUser, needsProject, async () => {
      const currentTargets: CurrentTarget[] = [];
      const existingTopicNames = needsProject ? await this.#files.listTopics() : [];
      let projectedTopicCount = existingTopicNames.length;
      let newTopicCount = 0;

      for (const target of targets) {
        assertReceiptTarget(target);
        const currentDocument = target.scope === "user"
          ? await this.#files.readPreferences()
          : await this.#files.readTopicDocument(target.name);
        const currentRevision = revisionOf(currentDocument);
        const alreadyApplied = currentRevision === target.finalRevision;
        if (!alreadyApplied) {
          assertRevision(targetLabel(target), target.expectedRevision, currentRevision);
        }

        if (target.scope === "user") {
          assertCapacity("preferences", target.finalDocument, currentDocument, DEFAULT_MAX_PREFERENCES_BYTES);
        } else {
          parseAndValidateTopicDocument(target.name, target.finalDocument);
          assertCapacity(target.name, target.finalDocument, currentDocument, MAX_MEMORY_TOPIC_BYTES);
          if (currentDocument === null && !alreadyApplied) {
            projectedTopicCount += 1;
            newTopicCount += 1;
          }
        }
        assertNoSecret(target.finalDocument);
        currentTargets.push({ target, alreadyApplied });
      }

      if (needsProject && newTopicCount > 0 && projectedTopicCount > MAX_MEMORY_TOPICS) {
        throw new MemoryCapacityError("project topics", projectedTopicCount, MAX_MEMORY_TOPICS);
      }

      let expectedFinalIndex: string | null = null;
      if (needsProject) {
        if (inputIndex === undefined) {
          throw new MemoryValidationError("Project Memory receipt requires a deterministic index document");
        }
        if (memoryRevision(inputIndex.finalDocument) !== inputIndex.finalRevision) {
          throw new MemoryValidationError("Final revision does not match project Memory index");
        }
        const currentIndex = await this.#files.readIndex();
        const currentIndexRevision = revisionOf(currentIndex);
        if (currentIndexRevision !== inputIndex.expectedRevision
          && currentIndexRevision !== inputIndex.finalRevision) {
          throw new MemoryRevisionConflictError(
            "project:index",
            inputIndex.expectedRevision,
            currentIndexRevision,
          );
        }
        expectedFinalIndex = this.#buildProjectedIndex(currentTargets, currentIndex);
        if (expectedFinalIndex !== inputIndex.finalDocument) {
          throw new MemoryValidationError("Receipt project index does not match its final topic documents");
        }
      } else if (inputIndex !== undefined) {
        throw new MemoryValidationError("Preferences-only Memory receipt cannot include a project index");
      }

      let applied = 0;
      let alreadyApplied = 0;
      for (const current of currentTargets) {
        if (current.alreadyApplied) {
          alreadyApplied += 1;
          continue;
        }
        if (current.target.scope === "user") {
          await this.#files.writePreferences(current.target.finalDocument);
        } else {
          await this.#files.writeTopicDocument(current.target.name, current.target.finalDocument);
        }
        applied += 1;
      }

      if (needsProject && inputIndex !== undefined) {
        const currentIndex = await this.#files.readIndex();
        if (currentIndex !== inputIndex.finalDocument) {
          await this.#files.writeIndexDocument(inputIndex.finalDocument);
        }
      }
      const indexDocument = needsProject ? await this.#files.readIndex() : null;
      if (needsProject && indexDocument !== expectedFinalIndex) {
        throw new MemoryValidationError("Applied project index does not match its durable receipt");
      }
      return { applied, alreadyApplied, indexRevision: revisionOf(indexDocument) };
    });
  }

  async #readPreferencesUnlocked(): Promise<MemoryPreferencesItem | null> {
    const document = await this.#files.readPreferences();
    return document === null ? null : toPreferencesItem(document);
  }

  async #readTopicUnlocked(name: string): Promise<MemoryTopicItem | null> {
    const document = await this.#files.readTopicDocument(name);
    return document === null ? null : topicItemFromDocument(name, document);
  }

  async #readIndexProjectionUnlocked(): Promise<MemoryIndexProjection> {
    const [content, topicNames] = await Promise.all([
      this.#files.readIndex(),
      this.#files.listTopics(),
    ]);
    const topicCount = createTopicCount(topicNames.length);
    return {
      content,
      revision: revisionOf(content),
      topicCount,
      availableForPrompt: topicCount.state !== "over-limit",
    };
  }

  async #assertTopicMutationAllowed(
    name: string,
    finalDocument: string,
    currentDocument: string | null,
  ): Promise<void> {
    assertCapacity(name, finalDocument, currentDocument, MAX_MEMORY_TOPIC_BYTES);
    if (currentDocument !== null) return;
    const topicCount = (await this.#files.listTopics()).length;
    if (topicCount >= MAX_MEMORY_TOPICS) {
      throw new MemoryCapacityError("project topics", topicCount + 1, MAX_MEMORY_TOPICS);
    }
  }

  #buildProjectedIndex(
    currentTargets: readonly CurrentTarget[],
    currentIndex: string | null,
  ): string {
    const entries = new Map(parseIndex(currentIndex ?? "").map((entry) => [entry.name, entry]));
    for (const current of currentTargets) {
      if (current.target.scope !== "project") continue;
      const { frontmatter } = parseAndValidateTopicDocument(
        current.target.name,
        current.target.finalDocument,
      );
      entries.set(current.target.name, {
        title: frontmatter.name,
        name: current.target.name,
        summary: frontmatter.description,
      });
    }
    return formatIndex(
      [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  async #withLanes<T>(
    user: boolean,
    project: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (user) {
      return await sharedMutationQueue.enqueue(this.#files.userRoot, async () => {
        if (project) {
          return await sharedMutationQueue.enqueue(this.#files.projectRoot, operation);
        }
        return await operation();
      });
    }
    if (project) {
      return await sharedMutationQueue.enqueue(this.#files.projectRoot, operation);
    }
    return await operation();
  }
}

export function memoryRevision(document: string): string {
  return createHash("sha256").update(document, "utf8").digest("hex");
}

function revisionOf(document: string | null): string | null {
  return document === null ? null : memoryRevision(document);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function createCapacity(bytes: number, maxBytes: number): MemoryCapacity {
  const state: MemoryCapacityState = bytes > maxBytes
    ? "over-limit"
    : bytes === maxBytes
      ? "at-limit"
      : "within-limit";
  return {
    bytes,
    maxBytes,
    state,
    mutationPolicy: state === "over-limit" ? "shrink-only" : "normal",
  };
}

function createTopicCount(count: number): MemoryTopicCount {
  return {
    count,
    max: MAX_MEMORY_TOPICS,
    state: count > MAX_MEMORY_TOPICS
      ? "over-limit"
      : count === MAX_MEMORY_TOPICS
        ? "at-limit"
        : "within-limit",
    canCreate: count < MAX_MEMORY_TOPICS,
  };
}

function toPreferencesItem(document: string): MemoryPreferencesItem {
  const capacity = createCapacity(utf8Bytes(document), DEFAULT_MAX_PREFERENCES_BYTES);
  return {
    content: document,
    revision: memoryRevision(document),
    capacity,
    availableForPrompt: capacity.state !== "over-limit",
  };
}

function topicItemFromDocument(name: string, document: string): MemoryTopicItem {
  const parsed = parseAndValidateTopicDocument(name, document);
  return {
    name,
    title: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    type: parsed.frontmatter.type,
    content: parsed.body,
    revision: memoryRevision(document),
    capacity: createCapacity(utf8Bytes(document), MAX_MEMORY_TOPIC_BYTES),
  };
}

function toTopicSummary(topic: MemoryTopicItem): MemoryTopicSummary {
  const { content: _content, ...summary } = topic;
  return summary;
}

function parseAndValidateTopicDocument(name: string, document: string) {
  assertTopicName(name);
  try {
    return parseFrontmatter(document);
  } catch {
    throw new MemoryValidationError(`Invalid topic document for ${name}`);
  }
}

function formatValidatedTopicDocument(
  topicName: string,
  metadata: Parameters<typeof formatFrontmatter>[0],
  content: string,
): string {
  assertCanonicalTopicMetadata(topicName, metadata);
  return formatFrontmatter(metadata, content);
}

function assertCanonicalTopicMetadata(
  topicName: string,
  metadata: Parameters<typeof formatFrontmatter>[0],
): void {
  const result = MemoryFrontmatterSchema.safeParse(metadata);
  if (!result.success) {
    throw new MemoryValidationError(`Invalid topic metadata for ${topicName}`);
  }
}

function assertTopicName(name: string): void {
  if (!TOPIC_NAME_PATTERN.test(name) || RESERVED_TOPIC_NAMES.has(name)) {
    throw new MemoryValidationError("Invalid Memory topic name");
  }
}

function assertNoSecret(document: string): void {
  if (containsSecretPattern(document).found) throw new MemorySecretError();
}

function assertRevision(
  target: string,
  expected: string | null,
  actual: string | null,
): void {
  if (expected !== actual) throw new MemoryRevisionConflictError(target, expected, actual);
}

function assertCapacity(
  target: string,
  finalDocument: string,
  currentDocument: string | null,
  maxBytes: number,
): void {
  const finalBytes = utf8Bytes(finalDocument);
  if (finalBytes <= maxBytes) return;
  const currentBytes = currentDocument === null ? 0 : utf8Bytes(currentDocument);
  if (currentBytes > maxBytes && finalBytes <= currentBytes) return;
  throw new MemoryCapacityError(target, finalBytes, maxBytes);
}

function assertReceiptTarget(target: MemoryFinalDocumentTarget): void {
  if (memoryRevision(target.finalDocument) !== target.finalRevision) {
    throw new MemoryValidationError(`Final revision does not match ${targetLabel(target)}`);
  }
  if (target.scope === "user") {
    if (target.name !== "preferences") {
      throw new MemoryValidationError("Only preferences can use user scope");
    }
    return;
  }
  assertTopicName(target.name);
}

function assertDocumentTarget(target: MemoryDocumentTarget): void {
  if (target.scope === "user") {
    if (target.name !== "preferences") {
      throw new MemoryValidationError("Only preferences can use user scope");
    }
    return;
  }
  assertTopicName(target.name);
}

function targetLabel(target: MemoryFinalDocumentTarget): string {
  return `${target.scope}:${target.name}`;
}

function compareTargets(left: MemoryFinalDocumentTarget, right: MemoryFinalDocumentTarget): number {
  return targetLabel(left).localeCompare(targetLabel(right));
}

function compareDocumentTargets(left: MemoryDocumentTarget, right: MemoryDocumentTarget): number {
  return `${left.scope}:${left.name}`.localeCompare(`${right.scope}:${right.name}`);
}

function assertUniqueTargets(targets: readonly MemoryFinalDocumentTarget[]): void {
  for (let index = 1; index < targets.length; index += 1) {
    if (targetLabel(targets[index - 1]) === targetLabel(targets[index])) {
      throw new MemoryValidationError(`Duplicate Memory target ${targetLabel(targets[index])}`);
    }
  }
}

function assertUniqueDocumentTargets(targets: readonly MemoryDocumentTarget[]): void {
  for (let index = 1; index < targets.length; index += 1) {
    const previous = `${targets[index - 1].scope}:${targets[index - 1].name}`;
    const current = `${targets[index].scope}:${targets[index].name}`;
    if (previous === current) {
      throw new MemoryValidationError("Duplicate Memory target");
    }
  }
}

function capacityWarnings(
  preferences: MemoryPreferencesItem | null,
  topics: readonly MemoryTopicSummary[],
  topicCount: MemoryTopicCount,
): MemoryBlockedWarning[] {
  const warnings: MemoryBlockedWarning[] = [];
  if (preferences?.capacity.state === "over-limit") {
    warnings.push({
      code: "preferences_over_capacity",
      target: "preferences",
      message: "Personal Memory is over 8 KiB and must be reduced before it can grow.",
    });
  }
  for (const topic of topics) {
    if (topic.capacity.state !== "over-limit") continue;
    warnings.push({
      code: "topic_over_capacity",
      target: topic.name,
      message: `Memory topic ${topic.name} is over 16 KiB and must be reduced before it can grow.`,
    });
  }
  if (topicCount.state === "over-limit") {
    warnings.push({
      code: "topic_count_over_capacity",
      target: "project topics",
      message: `Project Memory has ${topicCount.count} topics; reduce it to ${topicCount.max} before creating another topic.`,
    });
  }
  return warnings;
}

function compareWarnings(left: MemoryBlockedWarning, right: MemoryBlockedWarning): number {
  return (left.blockedAt ?? 0) - (right.blockedAt ?? 0)
    || (left.sessionId ?? "").localeCompare(right.sessionId ?? "")
    || left.code.localeCompare(right.code)
    || (left.target ?? "").localeCompare(right.target ?? "");
}
