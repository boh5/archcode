import {
  isValidAttachmentMediaType,
  isValidAttachmentName,
  MAX_ATTACHMENT_SIZE_BYTES,
  type AttachmentDescriptor,
} from "@archcode/protocol";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import {
  AttachmentConflictError,
  AttachmentCorruptedError,
  AttachmentNotFoundError,
  AttachmentPathSafetyError,
  AttachmentTooLargeError,
  AttachmentValidationError,
} from "./errors";
import { AsyncKeyedMutex, SessionAttachmentRootGate } from "./gate";

const ATTACHMENTS_SEGMENTS = [".archcode", "runtime", "attachments"] as const;
const METADATA_FILE_NAME = "metadata.json";
const CONTENT_FILE_NAME = "content";
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const StoredAttachmentMetadataSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_SIZE_BYTES),
  kind: z.enum(["image", "file"]),
  digest: z.string().regex(DIGEST_PATTERN),
});

type StoredAttachmentMetadata = z.infer<typeof StoredAttachmentMetadataSchema>;

export interface UploadSessionAttachmentInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mediaType?: string;
  readonly contentLength?: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface UploadProjectAttachmentResult {
  readonly descriptor: AttachmentDescriptor;
  readonly created: boolean;
}

export interface ResolveSessionAttachmentsInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly attachmentIds: readonly string[];
}

export interface OpenSessionAttachmentInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly attachmentId: string;
}

export interface OpenProjectAttachmentResult {
  readonly descriptor: AttachmentDescriptor;
  readonly contentPath: string;
}

export interface VerifiedProjectAttachment extends OpenProjectAttachmentResult {
  readonly bytes: Uint8Array;
}

export interface SessionAttachmentServiceOptions {
  readonly validateRootSession: (
    workspaceRoot: string,
    rootSessionId: string,
  ) => Promise<void>;
  readonly storage: ProjectAttachmentStorage;
}

export type AttachmentOwner =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "todo"; readonly id: string };

export interface UploadProjectAttachmentInput {
  readonly workspaceRoot: string;
  readonly owner: AttachmentOwner;
  readonly attachmentId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mediaType?: string;
  readonly contentLength?: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface ProjectAttachmentObjectInput {
  readonly workspaceRoot: string;
  readonly owner: AttachmentOwner;
  readonly attachmentId: string;
}

export interface ResolveProjectAttachmentsInput {
  readonly workspaceRoot: string;
  readonly owner: AttachmentOwner;
  readonly attachmentIds: readonly string[];
}

export interface ProjectAttachmentStorageOptions {
  /** Narrow test seam for best-effort cleanup failure coverage. */
  readonly removeDirectory?: (path: string) => Promise<void>;
}

interface AttachmentPaths {
  readonly projectRoot: string;
  readonly attachmentsRoot: string;
  readonly ownerDirectory: string;
  readonly finalDirectory: string;
  readonly metadataPath: string;
  readonly contentPath: string;
}

interface CompletedAttachment {
  readonly metadata: StoredAttachmentMetadata;
  readonly paths: AttachmentPaths;
}

export class ProjectAttachmentStorage {
  readonly #removeDirectory: (path: string) => Promise<void>;
  readonly #attachmentMutex = new AsyncKeyedMutex();

  constructor(options: ProjectAttachmentStorageOptions = {}) {
    this.#removeDirectory = options.removeDirectory
      ?? (async (path) => rm(path, { recursive: true, force: true }));
  }

  async upload(input: UploadProjectAttachmentInput): Promise<UploadProjectAttachmentResult> {
    validateAttachmentId(input.attachmentId);
    validateOwner(input.owner);
    validateAttachmentName(input.name);
    validateDeclaredSize(input.sizeBytes);
    validateContentLength(input.contentLength, input.sizeBytes);
    const attachmentKey = attachmentStorageKey(input);
    return await this.#attachmentMutex.withLock(
      attachmentKey,
      async () => await this.#uploadSerialized(input),
    );
  }

  async resolveDescriptors(
    input: ResolveProjectAttachmentsInput,
  ): Promise<AttachmentDescriptor[]> {
    validateOwner(input.owner);
    const descriptors: AttachmentDescriptor[] = [];
    for (const attachmentId of input.attachmentIds) {
      validateAttachmentId(attachmentId);
      const completed = await this.#readCompletedAttachment(
        input.workspaceRoot,
        input.owner,
        attachmentId,
      );
      descriptors.push(toDescriptor(completed.metadata));
    }
    return descriptors;
  }

  async openDownload(
    input: ProjectAttachmentObjectInput,
  ): Promise<OpenProjectAttachmentResult> {
    validateAttachmentId(input.attachmentId);
    validateOwner(input.owner);
    const completed = await this.#readCompletedAttachment(
      input.workspaceRoot,
      input.owner,
      input.attachmentId,
    );
    return {
      descriptor: toDescriptor(completed.metadata),
      contentPath: completed.paths.contentPath,
    };
  }

  async resolveReadPath(
    input: ProjectAttachmentObjectInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<string> {
    validateAttachmentId(input.attachmentId);
    validateOwner(input.owner);
    const completed = await this.#readCompletedAttachment(
      input.workspaceRoot,
      input.owner,
      input.attachmentId,
    );
    const descriptor = toDescriptor(completed.metadata);
    if (!descriptorsEqual(descriptor, expectedDescriptor)) {
      throw new AttachmentCorruptedError(
        input.attachmentId,
        `Attachment metadata no longer matches the durable descriptor: ${input.attachmentId}`,
      );
    }
    return completed.paths.contentPath;
  }

  async readVerified(
    input: ProjectAttachmentObjectInput,
    expectedDescriptor?: AttachmentDescriptor,
  ): Promise<VerifiedProjectAttachment> {
    validateAttachmentId(input.attachmentId);
    validateOwner(input.owner);
    const completed = await this.#readCompletedAttachment(
      input.workspaceRoot,
      input.owner,
      input.attachmentId,
    );
    const descriptor = toDescriptor(completed.metadata);
    if (expectedDescriptor !== undefined && !descriptorsEqual(descriptor, expectedDescriptor)) {
      throw new AttachmentCorruptedError(
        input.attachmentId,
        `Attachment metadata no longer matches the durable descriptor: ${input.attachmentId}`,
      );
    }
    const bytes = await Bun.file(completed.paths.contentPath).bytes();
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== completed.metadata.digest) {
      throw new AttachmentCorruptedError(
        input.attachmentId,
        `Attachment content digest mismatch: ${input.attachmentId}`,
      );
    }
    return { descriptor, contentPath: completed.paths.contentPath, bytes };
  }

  async removeAttachment(input: ProjectAttachmentObjectInput): Promise<void> {
    validateAttachmentId(input.attachmentId);
    validateOwner(input.owner);
    await this.#attachmentMutex.withLock(
      attachmentStorageKey(input),
      async () => {
        const completed = await this.#readCompletedAttachment(
          input.workspaceRoot,
          input.owner,
          input.attachmentId,
        );
        await this.#removeDirectory(completed.paths.finalDirectory);
      },
    );
  }

  async removeOwner(workspaceRoot: string, owner: AttachmentOwner): Promise<void> {
    validateOwner(owner);
    const paths = await this.#resolveOwnerPathsForCleanup(workspaceRoot, owner);
    if (paths === undefined) return;
    await this.#removeDirectory(paths.ownerDirectory);
  }

  async #uploadSerialized(
    input: UploadProjectAttachmentInput,
  ): Promise<UploadProjectAttachmentResult> {
    const paths = await this.#prepareWritablePaths(
      input.workspaceRoot,
      input.owner,
      input.attachmentId,
    );
    await this.#removeStaleTemps(paths.ownerDirectory, input.attachmentId);

    const tempDirectory = join(
      paths.ownerDirectory,
      tempDirectoryName(input.attachmentId, crypto.randomUUID()),
    );
    assertContained(paths.projectRoot, tempDirectory);
    await mkdir(tempDirectory);
    await assertDirectory(tempDirectory);
    const tempContentPath = join(tempDirectory, CONTENT_FILE_NAME);
    const tempMetadataPath = join(tempDirectory, METADATA_FILE_NAME);

    try {
      const streamed = await streamContent({
        body: input.body,
        destination: tempContentPath,
        expectedSize: input.sizeBytes,
      });
      const recognizedImageType = recognizeImageMediaType(streamed.prefix);
      const declaredMediaType = normalizeDisplayMediaType(input.mediaType);
      const recognizedMediaType = recognizedImageType
        ?? recognizePdfMediaType(streamed.prefix)
        ?? (declaredMediaType === "application/pdf" ? DEFAULT_MEDIA_TYPE : declaredMediaType);
      const metadata = StoredAttachmentMetadataSchema.parse({
        version: 1,
        id: input.attachmentId,
        name: input.name,
        mediaType: recognizedMediaType,
        sizeBytes: streamed.sizeBytes,
        kind: recognizedImageType === undefined ? "file" : "image",
        digest: streamed.digest,
      });
      await Bun.write(tempMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      await assertRegularFile(tempContentPath);
      await assertRegularFile(tempMetadataPath);
      StoredAttachmentMetadataSchema.parse(await Bun.file(tempMetadataPath).json());

      const finalExists = await pathExists(paths.finalDirectory);
      if (finalExists) {
        const existing = await this.#readCompletedAttachment(
          input.workspaceRoot,
          input.owner,
          input.attachmentId,
        );
        await assertStoredDigest(existing);
        if (!storedIdentityEqual(existing.metadata, metadata)) {
          throw new AttachmentConflictError(
            input.attachmentId,
            `Attachment ID is already bound to different content: ${input.attachmentId}`,
          );
        }
        await rm(tempDirectory, { recursive: true, force: true });
        return { descriptor: toDescriptor(existing.metadata), created: false };
      }

      await rename(tempDirectory, paths.finalDirectory);
      const completed = await this.#readCompletedAttachment(
        input.workspaceRoot,
        input.owner,
        input.attachmentId,
      );
      return { descriptor: toDescriptor(completed.metadata), created: true };
    } catch (error) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #prepareWritablePaths(
    workspaceRoot: string,
    owner: AttachmentOwner,
    attachmentId: string,
  ): Promise<AttachmentPaths> {
    const projectRoot = await canonicalProjectRoot(workspaceRoot);
    let parent = projectRoot;
    for (const segment of ATTACHMENTS_SEGMENTS) {
      parent = await ensureOwnedDirectory(parent, segment, projectRoot);
    }
    const attachmentsRoot = parent;
    const ownerTypeDirectory = await ensureOwnedDirectory(
      attachmentsRoot,
      ownerDirectoryName(owner),
      projectRoot,
    );
    const ownerDirectory = await ensureOwnedDirectory(
      ownerTypeDirectory,
      validatePathSegment(owner.id, "attachment owner ID"),
      projectRoot,
    );
    const finalDirectory = join(ownerDirectory, attachmentId);
    assertContained(projectRoot, finalDirectory);
    if (await pathExists(finalDirectory)) await assertDirectory(finalDirectory);
    return {
      projectRoot,
      attachmentsRoot,
      ownerDirectory,
      finalDirectory,
      metadataPath: join(finalDirectory, METADATA_FILE_NAME),
      contentPath: join(finalDirectory, CONTENT_FILE_NAME),
    };
  }

  async #readCompletedAttachment(
    workspaceRoot: string,
    owner: AttachmentOwner,
    attachmentId: string,
  ): Promise<CompletedAttachment> {
    const projectRoot = await canonicalProjectRoot(workspaceRoot);
    let parent = projectRoot;
    try {
      for (const segment of ATTACHMENTS_SEGMENTS) {
        parent = await openOwnedDirectory(parent, segment, projectRoot);
      }
      const attachmentsRoot = parent;
      const ownerTypeDirectory = await openOwnedDirectory(
        attachmentsRoot,
        ownerDirectoryName(owner),
        projectRoot,
      );
      const ownerDirectory = await openOwnedDirectory(
        ownerTypeDirectory,
        validatePathSegment(owner.id, "attachment owner ID"),
        projectRoot,
      );
      const finalDirectory = await openOwnedDirectory(
        ownerDirectory,
        attachmentId,
        projectRoot,
      );
      const metadataPath = join(finalDirectory, METADATA_FILE_NAME);
      const contentPath = join(finalDirectory, CONTENT_FILE_NAME);
      await assertRegularFileContained(projectRoot, metadataPath);
      await assertRegularFileContained(projectRoot, contentPath);
      const metadata = StoredAttachmentMetadataSchema.parse(
        await Bun.file(metadataPath).json(),
      );
      if (metadata.id !== attachmentId) {
        throw new AttachmentCorruptedError(
          attachmentId,
          `Attachment metadata ID mismatch: ${attachmentId}`,
        );
      }
      validateAttachmentName(metadata.name);
      if (
        metadata.mediaType !== normalizeDisplayMediaType(metadata.mediaType)
        && recognizeStoredImageMediaType(metadata.mediaType) === undefined
      ) {
        throw new AttachmentCorruptedError(
          attachmentId,
          `Attachment metadata media type is invalid: ${attachmentId}`,
        );
      }
      if (
        metadata.kind === "image"
        && recognizeStoredImageMediaType(metadata.mediaType) === undefined
      ) {
        throw new AttachmentCorruptedError(
          attachmentId,
          `Attachment image metadata is invalid: ${attachmentId}`,
        );
      }
      const contentStat = await stat(contentPath);
      if (contentStat.size !== metadata.sizeBytes) {
        throw new AttachmentCorruptedError(
          attachmentId,
          `Attachment content size mismatch: ${attachmentId}`,
        );
      }
      return {
        metadata,
        paths: {
          projectRoot,
          attachmentsRoot,
          ownerDirectory,
          finalDirectory,
          metadataPath,
          contentPath,
        },
      };
    } catch (error) {
      if (isMissingPathError(error)) throw new AttachmentNotFoundError(attachmentId);
      if (
        error instanceof z.ZodError
        || error instanceof SyntaxError
        || error instanceof AttachmentValidationError
      ) {
        throw new AttachmentCorruptedError(
          attachmentId,
          `Attachment metadata is invalid: ${attachmentId}`,
        );
      }
      throw error;
    }
  }

  async #removeStaleTemps(ownerDirectory: string, attachmentId: string): Promise<void> {
    const pattern = new RegExp(
      `^\\.${escapeRegExp(attachmentId)}\\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "i",
    );
    const entries = await readdir(ownerDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      const path = join(ownerDirectory, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new AttachmentPathSafetyError("Attachment temporary path is unsafe");
      }
      await rm(path, { recursive: true, force: true });
    }
  }

  async #resolveOwnerPathsForCleanup(
    workspaceRoot: string,
    owner: AttachmentOwner,
  ): Promise<Pick<AttachmentPaths, "projectRoot" | "attachmentsRoot" | "ownerDirectory"> | undefined> {
    const projectRoot = await canonicalProjectRoot(workspaceRoot);
    let parent = projectRoot;
    try {
      for (const segment of ATTACHMENTS_SEGMENTS) {
        parent = await openOwnedDirectory(parent, segment, projectRoot);
      }
      const attachmentsRoot = parent;
      const ownerTypeDirectory = await openOwnedDirectory(
        attachmentsRoot,
        ownerDirectoryName(owner),
        projectRoot,
      );
      const ownerDirectory = await openOwnedDirectory(
        ownerTypeDirectory,
        validatePathSegment(owner.id, "attachment owner ID"),
        projectRoot,
      );
      return { projectRoot, attachmentsRoot, ownerDirectory };
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }
}

export class SessionAttachmentService {
  readonly #validateRootSession: SessionAttachmentServiceOptions["validateRootSession"];
  readonly #storage: ProjectAttachmentStorage;
  readonly #rootGate = new SessionAttachmentRootGate();

  constructor(options: SessionAttachmentServiceOptions) {
    this.#validateRootSession = options.validateRootSession;
    this.#storage = options.storage;
  }

  async upload(input: UploadSessionAttachmentInput): Promise<UploadProjectAttachmentResult> {
    const rootKey = `${resolve(input.workspaceRoot)}\0${input.rootSessionId}`;
    return await this.#rootGate.withUpload(rootKey, async () => {
      // Validate after taking the lease so completed root deletion cannot be
      // followed by recreation of its attachment tree.
      await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
      return await this.#storage.upload({
        workspaceRoot: input.workspaceRoot,
        owner: { kind: "session", id: input.rootSessionId },
        attachmentId: input.attachmentId,
        name: input.name,
        sizeBytes: input.sizeBytes,
        mediaType: input.mediaType,
        contentLength: input.contentLength,
        body: input.body,
      });
    });
  }

  async resolveDescriptors(
    input: ResolveSessionAttachmentsInput,
  ): Promise<AttachmentDescriptor[]> {
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    return await this.#storage.resolveDescriptors({
      workspaceRoot: input.workspaceRoot,
      owner: { kind: "session", id: input.rootSessionId },
      attachmentIds: input.attachmentIds,
    });
  }

  async openDownload(input: OpenSessionAttachmentInput): Promise<OpenProjectAttachmentResult> {
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    return await this.#storage.openDownload(sessionObjectInput(input));
  }

  async resolveReadPath(
    input: OpenSessionAttachmentInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<string> {
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    return await this.#storage.resolveReadPath(sessionObjectInput(input), expectedDescriptor);
  }

  async readVerified(
    input: OpenSessionAttachmentInput,
    expectedDescriptor?: AttachmentDescriptor,
  ): Promise<VerifiedProjectAttachment> {
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    return await this.#storage.readVerified(sessionObjectInput(input), expectedDescriptor);
  }

  async withRootDeletionLease<T>(
    workspaceRoot: string,
    rootSessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const rootKey = `${resolve(workspaceRoot)}\0${rootSessionId}`;
    return await this.#rootGate.withDelete(rootKey, operation);
  }

  async cleanupRootAttachments(workspaceRoot: string, rootSessionId: string): Promise<void> {
    await this.#storage.removeOwner(workspaceRoot, { kind: "session", id: rootSessionId });
  }
}

function sessionObjectInput(input: OpenSessionAttachmentInput): ProjectAttachmentObjectInput {
  return {
    workspaceRoot: input.workspaceRoot,
    owner: { kind: "session", id: input.rootSessionId },
    attachmentId: input.attachmentId,
  };
}

function validateOwner(owner: AttachmentOwner): void {
  if (!z.uuid().safeParse(owner.id).success) {
    throw new AttachmentValidationError(`${owner.kind} attachment owner ID must be a UUID`);
  }
}

function ownerDirectoryName(owner: AttachmentOwner): "sessions" | "todos" {
  return owner.kind === "session" ? "sessions" : "todos";
}

function attachmentStorageKey(input: ProjectAttachmentObjectInput): string {
  return `${resolve(input.workspaceRoot)}\0${input.owner.kind}\0${input.owner.id}\0${input.attachmentId}`;
}

function validateAttachmentId(attachmentId: string): void {
  if (!z.uuid().safeParse(attachmentId).success) {
    throw new AttachmentValidationError("attachmentId must be a UUID");
  }
}

function validateAttachmentName(name: string): void {
  if (!isValidAttachmentName(name)) {
    throw new AttachmentValidationError("Attachment name is invalid");
  }
}

function validateDeclaredSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new AttachmentValidationError("sizeBytes must be a non-negative integer");
  }
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentTooLargeError(MAX_ATTACHMENT_SIZE_BYTES, sizeBytes);
  }
}

function validateContentLength(contentLength: number | undefined, sizeBytes: number): void {
  if (contentLength === undefined) return;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new AttachmentValidationError("Content-Length must be a non-negative integer");
  }
  if (contentLength > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentTooLargeError(MAX_ATTACHMENT_SIZE_BYTES, contentLength);
  }
  if (contentLength !== sizeBytes) {
    throw new AttachmentValidationError("Content-Length must equal sizeBytes");
  }
}

function normalizeDisplayMediaType(value: string | undefined): string {
  if (value === undefined) return DEFAULT_MEDIA_TYPE;
  const candidate = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    candidate.length === 0
    || !isValidAttachmentMediaType(candidate)
  ) {
    return DEFAULT_MEDIA_TYPE;
  }
  return candidate;
}

function recognizeImageMediaType(prefix: Uint8Array): string | undefined {
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const ascii = new TextDecoder().decode(prefix);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (prefix.byteLength >= 12 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function recognizeStoredImageMediaType(value: string): string | undefined {
  return value === "image/png"
    || value === "image/jpeg"
    || value === "image/gif"
    || value === "image/webp"
    ? value
    : undefined;
}

function recognizePdfMediaType(prefix: Uint8Array): "application/pdf" | undefined {
  return startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])
    ? "application/pdf"
    : undefined;
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.byteLength < expected.length) return false;
  return expected.every((byte, index) => bytes[index] === byte);
}

async function streamContent(input: {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly destination: string;
  readonly expectedSize: number;
}): Promise<{ sizeBytes: number; digest: string; prefix: Uint8Array }> {
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(input.destination).writer();
  const prefix = new Uint8Array(12);
  let prefixLength = 0;
  let sizeBytes = 0;
  const reader = input.body?.getReader();

  try {
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new AttachmentValidationError("Attachment body must contain bytes");
      }
      sizeBytes += value.byteLength;
      if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
        await reader.cancel("Attachment size limit exceeded").catch(() => undefined);
        throw new AttachmentTooLargeError(MAX_ATTACHMENT_SIZE_BYTES, sizeBytes);
      }
      if (sizeBytes > input.expectedSize) {
        await reader.cancel("Attachment body exceeds declared size").catch(() => undefined);
        throw new AttachmentValidationError("Attachment body size does not equal sizeBytes");
      }
      const copyLength = Math.min(prefix.byteLength - prefixLength, value.byteLength);
      if (copyLength > 0) {
        prefix.set(value.subarray(0, copyLength), prefixLength);
        prefixLength += copyLength;
      }
      hasher.update(value);
      await writer.write(value);
    }
    await writer.end();
  } catch (error) {
    await Promise.resolve(writer.end()).catch(() => undefined);
    throw error;
  }

  if (sizeBytes !== input.expectedSize) {
    throw new AttachmentValidationError("Attachment body size does not equal sizeBytes");
  }
  return {
    sizeBytes,
    digest: hasher.digest("hex"),
    prefix: prefix.subarray(0, prefixLength),
  };
}

async function assertStoredDigest(completed: CompletedAttachment): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  let sizeBytes = 0;
  for await (const chunk of Bun.file(completed.paths.contentPath).stream()) {
    sizeBytes += chunk.byteLength;
    hasher.update(chunk);
  }
  const digest = hasher.digest("hex");
  if (
    sizeBytes !== completed.metadata.sizeBytes
    || digest !== completed.metadata.digest
  ) {
    throw new AttachmentCorruptedError(
      completed.metadata.id,
      `Attachment content digest mismatch: ${completed.metadata.id}`,
    );
  }
}

async function canonicalProjectRoot(workspaceRoot: string): Promise<string> {
  const absolute = resolve(workspaceRoot);
  const info = await lstat(absolute);
  if (!info.isDirectory()) {
    throw new AttachmentPathSafetyError("Project root is not a directory");
  }
  return await realpath(absolute);
}

async function ensureOwnedDirectory(
  parent: string,
  segment: string,
  projectRoot: string,
): Promise<string> {
  const path = join(parent, validatePathSegment(segment, "storage path segment"));
  assertContained(projectRoot, path);
  try {
    await mkdir(path);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  await assertDirectoryContained(projectRoot, path);
  return path;
}

async function openOwnedDirectory(
  parent: string,
  segment: string,
  projectRoot: string,
): Promise<string> {
  const path = join(parent, validatePathSegment(segment, "storage path segment"));
  assertContained(projectRoot, path);
  await assertDirectoryContained(projectRoot, path);
  return path;
}

function validatePathSegment(value: string, label: string): string {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || /\p{Cc}/u.test(value)
  ) {
    throw new AttachmentPathSafetyError(`${label} is not a safe path segment`);
  }
  return value;
}

function assertContained(projectRoot: string, path: string): void {
  const rel = relative(projectRoot, resolve(path));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new AttachmentPathSafetyError("Attachment path escapes the project root");
}

async function assertDirectoryContained(projectRoot: string, path: string): Promise<void> {
  await assertDirectory(path);
  const resolved = await realpath(path);
  assertContained(projectRoot, resolved);
}

async function assertRegularFileContained(projectRoot: string, path: string): Promise<void> {
  await assertRegularFile(path);
  const resolved = await realpath(path);
  assertContained(projectRoot, resolved);
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AttachmentPathSafetyError("Attachment directory path is unsafe");
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AttachmentPathSafetyError("Attachment file path is unsafe");
  }
}

function tempDirectoryName(attachmentId: string, nonce: string): string {
  return `.${attachmentId}.tmp-${nonce}`;
}

function toDescriptor(metadata: StoredAttachmentMetadata): AttachmentDescriptor {
  return {
    id: metadata.id,
    name: metadata.name,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    kind: metadata.kind,
  };
}

function descriptorsEqual(left: AttachmentDescriptor, right: AttachmentDescriptor): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.mediaType === right.mediaType
    && left.sizeBytes === right.sizeBytes
    && left.kind === right.kind;
}

function storedIdentityEqual(
  left: StoredAttachmentMetadata,
  right: StoredAttachmentMetadata,
): boolean {
  return descriptorsEqual(toDescriptor(left), toDescriptor(right))
    && left.digest === right.digest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error) => {
    if (isMissingPathError(error)) return false;
    throw error;
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
