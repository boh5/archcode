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

const ATTACHMENTS_SEGMENTS = [".archcode", "attachments"] as const;
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

export interface UploadSessionAttachmentResult {
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

export interface OpenSessionAttachmentResult {
  readonly descriptor: AttachmentDescriptor;
  readonly contentPath: string;
}

export interface VerifiedSessionAttachment extends OpenSessionAttachmentResult {
  readonly bytes: Uint8Array;
}

export interface SessionAttachmentServiceOptions {
  readonly validateRootSession: (
    workspaceRoot: string,
    rootSessionId: string,
  ) => Promise<void>;
  /** Narrow test seam for best-effort root cleanup failure coverage. */
  readonly removeRootDirectory?: (path: string) => Promise<void>;
}

interface AttachmentPaths {
  readonly projectRoot: string;
  readonly attachmentsRoot: string;
  readonly rootDirectory: string;
  readonly finalDirectory: string;
  readonly metadataPath: string;
  readonly contentPath: string;
}

interface CompletedAttachment {
  readonly metadata: StoredAttachmentMetadata;
  readonly paths: AttachmentPaths;
}

export class SessionAttachmentService {
  readonly #validateRootSession: SessionAttachmentServiceOptions["validateRootSession"];
  readonly #removeRootDirectory: (path: string) => Promise<void>;
  readonly #rootGate = new SessionAttachmentRootGate();
  readonly #attachmentMutex = new AsyncKeyedMutex();

  constructor(options: SessionAttachmentServiceOptions) {
    this.#validateRootSession = options.validateRootSession;
    this.#removeRootDirectory = options.removeRootDirectory
      ?? (async (path) => rm(path, { recursive: true, force: true }));
  }

  async upload(input: UploadSessionAttachmentInput): Promise<UploadSessionAttachmentResult> {
    validateAttachmentId(input.attachmentId);
    validateAttachmentName(input.name);
    validateDeclaredSize(input.sizeBytes);
    validateContentLength(input.contentLength, input.sizeBytes);
    const workspaceKey = resolve(input.workspaceRoot);
    const rootKey = `${workspaceKey}\0${input.rootSessionId}`;

    return await this.#rootGate.withUpload(rootKey, async () => {
      // This check deliberately happens after taking the lease. A delete that
      // completed first cannot be followed by recreation of the attachment tree.
      await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
      const attachmentKey = `${rootKey}\0${input.attachmentId}`;
      return await this.#attachmentMutex.withLock(
        attachmentKey,
        async () => await this.#uploadSerialized(input),
      );
    });
  }

  async resolveDescriptors(
    input: ResolveSessionAttachmentsInput,
  ): Promise<AttachmentDescriptor[]> {
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    const descriptors: AttachmentDescriptor[] = [];
    for (const attachmentId of input.attachmentIds) {
      validateAttachmentId(attachmentId);
      const completed = await this.#readCompletedAttachment(
        input.workspaceRoot,
        input.rootSessionId,
        attachmentId,
      );
      descriptors.push(toDescriptor(completed.metadata));
    }
    return descriptors;
  }

  async openDownload(
    input: OpenSessionAttachmentInput,
  ): Promise<OpenSessionAttachmentResult> {
    validateAttachmentId(input.attachmentId);
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    const completed = await this.#readCompletedAttachment(
      input.workspaceRoot,
      input.rootSessionId,
      input.attachmentId,
    );
    return {
      descriptor: toDescriptor(completed.metadata),
      contentPath: completed.paths.contentPath,
    };
  }

  async resolveReadPath(
    input: OpenSessionAttachmentInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<string> {
    validateAttachmentId(input.attachmentId);
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    const completed = await this.#readCompletedAttachment(
      input.workspaceRoot,
      input.rootSessionId,
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
    input: OpenSessionAttachmentInput,
    expectedDescriptor?: AttachmentDescriptor,
  ): Promise<VerifiedSessionAttachment> {
    validateAttachmentId(input.attachmentId);
    await this.#validateRootSession(input.workspaceRoot, input.rootSessionId);
    const completed = await this.#readCompletedAttachment(
      input.workspaceRoot,
      input.rootSessionId,
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

  async withRootDeletionLease<T>(
    workspaceRoot: string,
    rootSessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const rootKey = `${resolve(workspaceRoot)}\0${rootSessionId}`;
    return await this.#rootGate.withDelete(rootKey, operation);
  }

  async cleanupRootAttachments(
    workspaceRoot: string,
    rootSessionId: string,
  ): Promise<void> {
    const paths = await this.#resolveRootPathsForCleanup(workspaceRoot, rootSessionId);
    if (paths === undefined) return;
    await this.#removeRootDirectory(paths.rootDirectory);
  }

  async #uploadSerialized(
    input: UploadSessionAttachmentInput,
  ): Promise<UploadSessionAttachmentResult> {
    const paths = await this.#prepareWritablePaths(
      input.workspaceRoot,
      input.rootSessionId,
      input.attachmentId,
    );
    await this.#removeStaleTemps(paths.rootDirectory, input.attachmentId);

    const tempDirectory = join(
      paths.rootDirectory,
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
      const metadata = StoredAttachmentMetadataSchema.parse({
        version: 1,
        id: input.attachmentId,
        name: input.name,
        mediaType: recognizedImageType ?? normalizeDisplayMediaType(input.mediaType),
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
          input.rootSessionId,
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
        input.rootSessionId,
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
    rootSessionId: string,
    attachmentId: string,
  ): Promise<AttachmentPaths> {
    const projectRoot = await canonicalProjectRoot(workspaceRoot);
    let parent = projectRoot;
    for (const segment of ATTACHMENTS_SEGMENTS) {
      parent = await ensureOwnedDirectory(parent, segment, projectRoot);
    }
    const attachmentsRoot = parent;
    const rootDirectory = await ensureOwnedDirectory(
      attachmentsRoot,
      validatePathSegment(rootSessionId, "root Session ID"),
      projectRoot,
    );
    const finalDirectory = join(rootDirectory, attachmentId);
    assertContained(projectRoot, finalDirectory);
    if (await pathExists(finalDirectory)) await assertDirectory(finalDirectory);
    return {
      projectRoot,
      attachmentsRoot,
      rootDirectory,
      finalDirectory,
      metadataPath: join(finalDirectory, METADATA_FILE_NAME),
      contentPath: join(finalDirectory, CONTENT_FILE_NAME),
    };
  }

  async #readCompletedAttachment(
    workspaceRoot: string,
    rootSessionId: string,
    attachmentId: string,
  ): Promise<CompletedAttachment> {
    const projectRoot = await canonicalProjectRoot(workspaceRoot);
    let parent = projectRoot;
    try {
      for (const segment of ATTACHMENTS_SEGMENTS) {
        parent = await openOwnedDirectory(parent, segment, projectRoot);
      }
      const attachmentsRoot = parent;
      const rootDirectory = await openOwnedDirectory(
        attachmentsRoot,
        validatePathSegment(rootSessionId, "root Session ID"),
        projectRoot,
      );
      const finalDirectory = await openOwnedDirectory(
        rootDirectory,
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
          rootDirectory,
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

  async #removeStaleTemps(rootDirectory: string, attachmentId: string): Promise<void> {
    const pattern = new RegExp(
      `^\\.${escapeRegExp(attachmentId)}\\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "i",
    );
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      const path = join(rootDirectory, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new AttachmentPathSafetyError("Attachment temporary path is unsafe");
      }
      await rm(path, { recursive: true, force: true });
    }
  }

  async #resolveRootPathsForCleanup(
    workspaceRoot: string,
    rootSessionId: string,
  ): Promise<Pick<AttachmentPaths, "projectRoot" | "attachmentsRoot" | "rootDirectory"> | undefined> {
    const projectRoot = await canonicalProjectRoot(workspaceRoot);
    let parent = projectRoot;
    try {
      for (const segment of ATTACHMENTS_SEGMENTS) {
        parent = await openOwnedDirectory(parent, segment, projectRoot);
      }
      const attachmentsRoot = parent;
      const rootDirectory = await openOwnedDirectory(
        attachmentsRoot,
        validatePathSegment(rootSessionId, "root Session ID"),
        projectRoot,
      );
      return { projectRoot, attachmentsRoot, rootDirectory };
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }
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
