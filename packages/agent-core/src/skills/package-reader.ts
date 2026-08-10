import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  parseSkillHeaderBytes,
  parseSkillMarkdown,
  SKILL_ENTRY_MAX_BYTES,
  SKILL_FRONTMATTER_MAX_BYTES,
} from "./schema";
import type {
  BuiltinSkillPackage,
  SkillPackageSnapshot,
  SkillMetadata,
  SkillResourceDescriptor,
  SkillSource,
} from "./types";

export const SKILL_ENTRY_FILE = "SKILL.md";
export const SKILL_RESOURCE_MAX_BYTES = 1024 * 1024;
export const SKILL_RESOURCE_MAX_FILES = 128;
export const SKILL_PACKAGE_MAX_ENTRIES = 256;
export const SKILL_RESOURCE_MAX_DEPTH = 8;
export const SKILL_PACKAGE_MAX_BYTES = 8 * 1024 * 1024;

const DISCOVERY_READ_MAX_BYTES = SKILL_FRONTMATTER_MAX_BYTES + 16;

export interface ActivatedSkillPackage {
  readonly metadata: SkillMetadata;
  readonly body: string;
  readonly resources: readonly SkillResourceDescriptor[];
}

export interface FilesystemSkillPackageLocation {
  /** Trusted workspace or user boundary. Every descendant through root is checked without following symlinks. */
  readonly boundaryRoot: string;
  readonly root: string;
}

export class SkillPackageResourceNotFoundError extends Error {
  constructor(public readonly resource: string) {
    super(`Skill resource is not listed: ${resource}`);
    this.name = "SkillPackageResourceNotFoundError";
  }
}

export class SkillPackageResourcePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPackageResourcePathError";
  }
}

export async function filesystemSkillDirectoryExists(
  location: FilesystemSkillPackageLocation,
): Promise<boolean> {
  try {
    await assertFilesystemSkillAncestry(location);
    return true;
  } catch (error) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

export async function discoverFilesystemSkill(
  location: FilesystemSkillPackageLocation,
  expectedName: string,
): Promise<SkillMetadata> {
  const { root } = location;
  await assertFilesystemSkillAncestry(location);
  await assertRegularDirectory(root, "Skill package root");
  await assertExactSkillEntryName(root);
  const entryPath = join(root, SKILL_ENTRY_FILE);
  await assertRegularFile(entryPath, "SKILL.md");
  const headerBytes = await readPrefix(entryPath, DISCOVERY_READ_MAX_BYTES);
  const { metadata } = parseSkillHeaderBytes(headerBytes);
  assertExpectedName(metadata, expectedName);
  await assertFilesystemSkillAncestry(location);
  return metadata;
}

export async function activateFilesystemSkill(
  location: FilesystemSkillPackageLocation,
  expectedName: string,
): Promise<ActivatedSkillPackage> {
  const { root } = location;
  await assertFilesystemSkillAncestry(location);
  await assertRegularDirectory(root, "Skill package root");
  await assertExactSkillEntryName(root);
  const entryPath = join(root, SKILL_ENTRY_FILE);
  const entryBytes = await readRegularFileBounded(entryPath, SKILL_ENTRY_MAX_BYTES, "SKILL.md");
  let entryText: string;
  try {
    entryText = new TextDecoder("utf-8", { fatal: true }).decode(entryBytes);
  } catch {
    throw new Error("SKILL.md must be valid UTF-8");
  }
  const { metadata, body } = parseSkillMarkdown(entryText);
  assertExpectedName(metadata, expectedName);
  const resources = await walkFilesystemResources(root, entryBytes.byteLength);
  await assertFilesystemSkillAncestry(location);
  return { metadata, body, resources };
}

export async function readFilesystemSkillResource(
  location: FilesystemSkillPackageLocation,
  expectedName: string,
  resource: string,
): Promise<{ readonly descriptor: SkillResourceDescriptor; readonly content: Uint8Array }> {
  const { root } = location;
  validateResourcePath(resource);
  const activated = await activateFilesystemSkill(location, expectedName);
  const descriptor = activated.resources.find((candidate) => candidate.path === resource);
  if (descriptor === undefined) throw new SkillPackageResourceNotFoundError(resource);
  const ancestry = await captureResourceDirectoryIdentity(location, resource);
  const content = await readRegularFileBounded(
    join(root, ...resource.split("/")),
    SKILL_RESOURCE_MAX_BYTES,
    `Skill resource "${resource}"`,
  );
  if (content.byteLength !== descriptor.bytes) {
    throw new Error(`Skill resource changed while reading: ${resource}`);
  }
  await assertDirectoryIdentityUnchanged(ancestry);
  await assertFilesystemSkillAncestry(location);
  return { descriptor, content };
}

export function discoverBuiltinSkill(
  skillPackage: BuiltinSkillPackage,
  expectedName: string,
): SkillMetadata {
  const entryBytes = encodeUtf8Prefix(skillPackage.entry, DISCOVERY_READ_MAX_BYTES);
  const { metadata } = parseSkillHeaderBytes(entryBytes);
  assertExpectedName(metadata, expectedName);
  return metadata;
}

export function activateBuiltinSkill(
  skillPackage: BuiltinSkillPackage,
  expectedName: string,
): ActivatedSkillPackage {
  const entryBytes = new TextEncoder().encode(skillPackage.entry);
  if (entryBytes.byteLength > SKILL_ENTRY_MAX_BYTES) {
    throw new Error(`SKILL.md exceeds ${SKILL_ENTRY_MAX_BYTES} bytes`);
  }
  const { metadata, body } = parseSkillMarkdown(skillPackage.entry);
  assertExpectedName(metadata, expectedName);
  const resources = builtinResourceDescriptors(skillPackage, entryBytes.byteLength);
  return { metadata, body, resources };
}

export function readBuiltinSkillResource(
  skillPackage: BuiltinSkillPackage,
  expectedName: string,
  resource: string,
): { readonly descriptor: SkillResourceDescriptor; readonly content: Uint8Array } {
  validateResourcePath(resource);
  const activated = activateBuiltinSkill(skillPackage, expectedName);
  const descriptor = activated.resources.find((candidate) => candidate.path === resource);
  if (descriptor === undefined) throw new SkillPackageResourceNotFoundError(resource);
  const value = skillPackage.resources[resource];
  if (value === undefined) throw new Error(`Skill resource is not embedded: ${resource}`);
  const content = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  return { descriptor, content };
}

export async function snapshotFilesystemSkill(
  location: FilesystemSkillPackageLocation,
  expectedName: string,
  source: Exclude<SkillSource, "builtin">,
  sourceLabel = location.root,
): Promise<SkillPackageSnapshot> {
  const { root } = location;
  await assertFilesystemSkillAncestry(location);
  const rootIdentity = await assertRegularDirectory(root, "Skill package root");
  await assertExactSkillEntryName(root);
  const entryBytes = await readRegularFileBounded(
    join(root, SKILL_ENTRY_FILE),
    SKILL_ENTRY_MAX_BYTES,
    "SKILL.md",
  );
  const entryText = decodeEntry(entryBytes);
  const { metadata, body } = parseSkillMarkdown(entryText);
  assertExpectedName(metadata, expectedName);
  const captured = await captureFilesystemResources(location, entryBytes.byteLength);
  await assertSamePathIdentity(root, rootIdentity, "Skill package root");
  await assertFilesystemSkillAncestry(location);
  return createSnapshot({
    name: expectedName,
    source,
    sourceLabel,
    root,
    metadata,
    body,
    entryBytes,
    resources: captured,
  });
}

export function snapshotBuiltinSkill(
  skillPackage: BuiltinSkillPackage,
  expectedName: string,
): SkillPackageSnapshot {
  const entryBytes = new TextEncoder().encode(skillPackage.entry);
  if (entryBytes.byteLength > SKILL_ENTRY_MAX_BYTES) {
    throw new Error(`SKILL.md exceeds ${SKILL_ENTRY_MAX_BYTES} bytes`);
  }
  const { metadata, body } = parseSkillMarkdown(skillPackage.entry);
  assertExpectedName(metadata, expectedName);
  const descriptors = builtinResourceDescriptors(skillPackage, entryBytes.byteLength);
  const resources = descriptors.map((descriptor) => {
    const value = skillPackage.resources[descriptor.path];
    if (value === undefined) throw new Error(`Skill resource is missing: ${descriptor.path}`);
    const content = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
    return { descriptor, content };
  });
  return createSnapshot({
    name: expectedName,
    source: "builtin",
    sourceLabel: "builtin",
    metadata,
    body,
    entryBytes,
    resources,
  });
}

export function validateResourcePath(resource: string): void {
  if (resource.length === 0) throw new SkillPackageResourcePathError("Skill resource path must not be empty");
  if (resource.includes("\0")) throw new SkillPackageResourcePathError("Skill resource path must not contain NUL bytes");
  if (resource.includes("\\")) throw new SkillPackageResourcePathError("Skill resource path must use POSIX separators");
  if (posix.isAbsolute(resource)) throw new SkillPackageResourcePathError("Skill resource path must be relative");
  const segments = resource.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SkillPackageResourcePathError("Skill resource path contains an invalid segment");
  }
  if (segments.length > SKILL_RESOURCE_MAX_DEPTH) {
    throw new SkillPackageResourcePathError(`Skill resource depth exceeds ${SKILL_RESOURCE_MAX_DEPTH}`);
  }
  if (segments[0]?.toLowerCase() === SKILL_ENTRY_FILE.toLowerCase()) {
    throw new SkillPackageResourcePathError("SKILL.md is the package entry and cannot be a resource directory");
  }
}

async function walkFilesystemResources(
  root: string,
  entryBytes: number,
): Promise<readonly SkillResourceDescriptor[]> {
  const resources: SkillResourceDescriptor[] = [];
  let totalEntries = 0;
  let totalBytes = entryBytes;

  async function walk(directory: string, prefix: readonly string[]): Promise<void> {
    const directoryIdentity = await assertRegularDirectory(
      directory,
      prefix.length === 0 ? "Skill package root" : `Skill resource directory "${prefix.join("/")}"`,
    );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => lexicalCompare(a.name, b.name));
    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > SKILL_PACKAGE_MAX_ENTRIES) {
        throw new Error(`Skill package contains more than ${SKILL_PACKAGE_MAX_ENTRIES} directory entries`);
      }
      const segments = [...prefix, entry.name];
      const relativePath = segments.join("/");
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill package symlinks are not allowed: ${relativePath}`);
      if (entry.isDirectory()) {
        if (segments.length > SKILL_RESOURCE_MAX_DEPTH) {
          throw new Error(`Skill resource depth exceeds ${SKILL_RESOURCE_MAX_DEPTH}: ${relativePath}`);
        }
        await assertRegularDirectory(absolutePath, `Skill resource directory "${relativePath}"`);
        await walk(absolutePath, segments);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Skill package entry must be a regular file: ${relativePath}`);
      if (prefix.length === 0 && entry.name === SKILL_ENTRY_FILE) continue;
      validateResourcePath(relativePath);
      const info = await assertRegularFile(absolutePath, `Skill resource "${relativePath}"`);
      if (info.size > SKILL_RESOURCE_MAX_BYTES) {
        throw new Error(`Skill resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes: ${relativePath}`);
      }
      resources.push(Object.freeze({ path: relativePath, bytes: info.size }));
      if (resources.length > SKILL_RESOURCE_MAX_FILES) {
        throw new Error(`Skill package contains more than ${SKILL_RESOURCE_MAX_FILES} resource files`);
      }
      totalBytes += info.size;
      if (totalBytes > SKILL_PACKAGE_MAX_BYTES) {
        throw new Error(`Skill package exceeds ${SKILL_PACKAGE_MAX_BYTES} aggregate bytes`);
      }
    }
    await assertSamePathIdentity(
      directory,
      directoryIdentity,
      prefix.length === 0 ? "Skill package root" : `Skill resource directory "${prefix.join("/")}"`,
    );
  }

  await walk(root, []);
  return Object.freeze(resources.sort((a, b) => lexicalCompare(a.path, b.path)));
}

interface CapturedResource {
  readonly descriptor: SkillResourceDescriptor;
  readonly content: Uint8Array;
}

async function captureFilesystemResources(
  location: FilesystemSkillPackageLocation,
  entryBytes: number,
): Promise<readonly CapturedResource[]> {
  const captured: CapturedResource[] = [];
  let totalEntries = 0;
  let totalBytes = entryBytes;

  async function walk(directory: string, prefix: readonly string[]): Promise<void> {
    const label = prefix.length === 0
      ? "Skill package root"
      : `Skill resource directory "${prefix.join("/")}"`;
    const directoryIdentity = await assertRegularDirectory(directory, label);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => lexicalCompare(a.name, b.name));
    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > SKILL_PACKAGE_MAX_ENTRIES) {
        throw new Error(`Skill package contains more than ${SKILL_PACKAGE_MAX_ENTRIES} directory entries`);
      }
      const segments = [...prefix, entry.name];
      const resourcePath = segments.join("/");
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill package symlinks are not allowed: ${resourcePath}`);
      }
      if (entry.isDirectory()) {
        if (segments.length > SKILL_RESOURCE_MAX_DEPTH) {
          throw new Error(`Skill resource depth exceeds ${SKILL_RESOURCE_MAX_DEPTH}: ${resourcePath}`);
        }
        await walk(absolutePath, segments);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Skill package entry must be a regular file: ${resourcePath}`);
      }
      if (prefix.length === 0 && entry.name === SKILL_ENTRY_FILE) continue;
      validateResourcePath(resourcePath);
      const content = await readRegularFileBounded(
        absolutePath,
        SKILL_RESOURCE_MAX_BYTES,
        `Skill resource "${resourcePath}"`,
      );
      totalBytes += content.byteLength;
      if (totalBytes > SKILL_PACKAGE_MAX_BYTES) {
        throw new Error(`Skill package exceeds ${SKILL_PACKAGE_MAX_BYTES} aggregate bytes`);
      }
      captured.push({
        descriptor: Object.freeze({ path: resourcePath, bytes: content.byteLength }),
        content,
      });
      if (captured.length > SKILL_RESOURCE_MAX_FILES) {
        throw new Error(`Skill package contains more than ${SKILL_RESOURCE_MAX_FILES} resource files`);
      }
    }
    await assertSamePathIdentity(directory, directoryIdentity, label);
  }

  await walk(location.root, []);
  return Object.freeze(captured.sort((a, b) => lexicalCompare(a.descriptor.path, b.descriptor.path)));
}

function createSnapshot(input: {
  readonly name: string;
  readonly source: SkillSource;
  readonly sourceLabel: string;
  readonly root?: string;
  readonly metadata: SkillMetadata;
  readonly body: string;
  readonly entryBytes: Uint8Array;
  readonly resources: readonly CapturedResource[];
}): SkillPackageSnapshot {
  const entryBytes = input.entryBytes.slice();
  const resourceBytes = new Map(
    input.resources.map(({ descriptor, content }) => [descriptor.path, content.slice()]),
  );
  const resources = Object.freeze(
    input.resources.map(({ descriptor }) => Object.freeze({ ...descriptor })),
  );
  const metadata = freezeMetadata(input.metadata);
  const digest = digestSnapshot(input.source, entryBytes, input.resources);
  const resolved = Object.freeze({
    metadata,
    body: input.body,
    source: input.source,
    sourceLabel: input.sourceLabel,
    ...(input.root === undefined ? {} : { root: input.root }),
    resources,
  });
  return Object.freeze({
    name: input.name,
    source: input.source,
    sourceLabel: input.sourceLabel,
    ...(input.root === undefined ? {} : { root: input.root }),
    metadata,
    body: input.body,
    resources,
    digest,
    readEntry: () => resolved,
    readResource: (resource: string) => {
      validateResourcePath(resource);
      const descriptor = resources.find((candidate) => candidate.path === resource);
      const content = resourceBytes.get(resource);
      if (descriptor === undefined || content === undefined) {
        throw new SkillPackageResourceNotFoundError(resource);
      }
      return {
        skillName: input.name,
        source: input.source,
        sourceLabel: input.sourceLabel,
        ...(input.root === undefined ? {} : { root: input.root }),
        resource: descriptor,
        content: content.slice(),
      };
    },
  });
}

function digestSnapshot(
  source: SkillSource,
  entryBytes: Uint8Array,
  resources: readonly CapturedResource[],
): string {
  const hash = createHash("sha256");
  updateDigestField(hash, new TextEncoder().encode(source));
  updateDigestField(hash, entryBytes);
  for (const { descriptor, content } of resources) {
    updateDigestField(hash, new TextEncoder().encode(descriptor.path));
    updateDigestLength(hash, descriptor.bytes);
    hash.update(content);
  }
  return hash.digest("hex");
}

function updateDigestField(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  updateDigestLength(hash, bytes.byteLength);
  hash.update(bytes);
}

function updateDigestLength(hash: ReturnType<typeof createHash>, length: number): void {
  const value = Buffer.allocUnsafe(8);
  value.writeBigUInt64BE(BigInt(length));
  hash.update(value);
}

function freezeMetadata(metadata: SkillMetadata): SkillMetadata {
  const values = metadata.metadata === undefined ? undefined : Object.freeze({ ...metadata.metadata });
  return Object.freeze({ ...metadata, ...(values === undefined ? {} : { metadata: values }) });
}

function decodeEntry(entryBytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(entryBytes);
  } catch {
    throw new Error("SKILL.md must be valid UTF-8");
  }
}

function builtinResourceDescriptors(
  skillPackage: BuiltinSkillPackage,
  entryBytes: number,
): readonly SkillResourceDescriptor[] {
  const paths = Object.keys(skillPackage.resources).sort(lexicalCompare);
  if (paths.length > SKILL_RESOURCE_MAX_FILES) {
    throw new Error(`Skill package contains more than ${SKILL_RESOURCE_MAX_FILES} resource files`);
  }
  const directories = new Set<string>();
  const pathSet = new Set(paths);
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/");
      if (pathSet.has(directory)) {
        throw new Error(`Builtin Skill resource path is both a file and directory: ${directory}`);
      }
      directories.add(directory);
    }
  }
  if (paths.length + directories.size + 1 > SKILL_PACKAGE_MAX_ENTRIES) {
    throw new Error(`Skill package contains more than ${SKILL_PACKAGE_MAX_ENTRIES} directory entries`);
  }
  let totalBytes = entryBytes;
  const resources = paths.map((path) => {
    validateResourcePath(path);
    const value = skillPackage.resources[path];
    if (value === undefined) throw new Error(`Skill resource is missing: ${path}`);
    const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
    if (bytes > SKILL_RESOURCE_MAX_BYTES) {
      throw new Error(`Skill resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes: ${path}`);
    }
    totalBytes += bytes;
    if (totalBytes > SKILL_PACKAGE_MAX_BYTES) {
      throw new Error(`Skill package exceeds ${SKILL_PACKAGE_MAX_BYTES} aggregate bytes`);
    }
    return Object.freeze({ path, bytes });
  });
  return Object.freeze(resources);
}

async function readPrefix(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = new Uint8Array(maxBytes);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("SKILL.md must be a regular file");
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readRegularFileBounded(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const pathInfo = await assertRegularFile(path, label);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
    assertSameIdentity(pathInfo, info, label);
    if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const buffer = new Uint8Array(info.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== info.size || after.size !== info.size) throw new Error(`${label} changed while reading`);
    assertSameIdentity(info, after, label);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function assertRegularDirectory(path: string, label: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  return info;
}

interface FileIdentity {
  readonly path: string;
  readonly label: string;
  readonly dev: number;
  readonly ino: number;
}

async function assertExactSkillEntryName(root: string): Promise<void> {
  const names = await readdir(root);
  const aliases = names.filter((name) => name.toLowerCase() === SKILL_ENTRY_FILE.toLowerCase());
  if (aliases.length !== 1 || aliases[0] !== SKILL_ENTRY_FILE) {
    throw new Error(`Skill package entry must be named exactly ${SKILL_ENTRY_FILE}`);
  }
}

async function captureResourceDirectoryIdentity(
  location: FilesystemSkillPackageLocation,
  resource: string,
): Promise<readonly FileIdentity[]> {
  await assertFilesystemSkillAncestry(location);
  const identities: FileIdentity[] = [];
  let current = location.root;
  const parentSegments = resource.split("/").slice(0, -1);
  const roots = ["", ...parentSegments];
  for (const segment of roots) {
    if (segment !== "") current = join(current, segment);
    const label = segment === "" ? "Skill package root" : `Skill resource directory "${current}"`;
    const info = await assertRegularDirectory(current, label);
    identities.push({ path: current, label, dev: info.dev, ino: info.ino });
  }
  return identities;
}

async function assertDirectoryIdentityUnchanged(
  identities: readonly FileIdentity[],
): Promise<void> {
  for (const identity of identities) {
    const info = await assertRegularDirectory(identity.path, identity.label);
    assertSameIdentity(identity, info, identity.label);
  }
}

async function assertSamePathIdentity(
  path: string,
  expected: { readonly dev: number; readonly ino: number },
  label: string,
): Promise<void> {
  const current = await lstat(path);
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error(`${label} changed while reading`);
  }
  assertSameIdentity(expected, current, label);
}

function assertSameIdentity(
  expected: { readonly dev: number; readonly ino: number },
  actual: { readonly dev: number; readonly ino: number },
  label: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`${label} changed while reading`);
  }
}

export async function assertFilesystemSkillAncestry(
  location: FilesystemSkillPackageLocation,
): Promise<void> {
  const boundaryRoot = resolve(location.boundaryRoot);
  const packageRoot = resolve(location.root);
  const descendant = relative(boundaryRoot, packageRoot);
  if (
    descendant === ""
    || descendant === ".."
    || descendant.startsWith(`..${sep}`)
    || isAbsolute(descendant)
  ) {
    throw new Error(`Skill filesystem root must be contained by its source boundary: ${packageRoot}`);
  }

  await assertRegularDirectory(boundaryRoot, "Skill source boundary");
  let current = boundaryRoot;
  for (const segment of descendant.split(sep)) {
    current = join(current, segment);
    await assertRegularDirectory(current, `Skill package ancestry "${current}"`);
  }
}

async function assertRegularFile(path: string, label: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  return info;
}

function encodeUtf8Prefix(value: string, maxBytes: number): Uint8Array {
  const output = new Uint8Array(maxBytes);
  const encoder = new TextEncoder();
  let offset = 0;
  for (const character of value) {
    const bytes = encoder.encode(character);
    if (offset + bytes.byteLength > maxBytes) break;
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return output.subarray(0, offset);
}

function assertExpectedName(metadata: SkillMetadata, expectedName: string): void {
  if (metadata.name !== expectedName) {
    throw new Error(
      `frontmatter.name must match package directory "${expectedName}" (received "${metadata.name}")`,
    );
  }
}

function isNoEntryError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
