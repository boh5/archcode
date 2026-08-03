import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@archcode/protocol";
import {
  AttachmentConflictError,
  AttachmentCorruptedError,
  AttachmentPathSafetyError,
  AttachmentTooLargeError,
  AttachmentValidationError,
} from "./errors";
import { getAttachmentContentPath } from "./paths";
import { ProjectAttachmentStorage, SessionAttachmentService } from "./service";

const TEST_ROOT = resolve(
  "/tmp",
  "archcode-session-attachment-service",
  crypto.randomUUID(),
);
const ROOT_SESSION_ID = crypto.randomUUID();

let rootExists = true;
let service: SessionAttachmentService;

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
  rootExists = true;
  service = new SessionAttachmentService({
    storage: new ProjectAttachmentStorage(),
    validateRootSession: async () => {
      if (!rootExists) {
        const error = new Error("missing root") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
    },
  });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("SessionAttachmentService", () => {
  test("streams recognized PNG bytes into an atomic private object", async () => {
    const attachmentId = crypto.randomUUID();
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);

    const uploaded = await service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "diagram.png",
      sizeBytes: png.byteLength,
      mediaType: "text/plain; charset=UTF-8",
      contentLength: png.byteLength,
      body: byteStream(png.subarray(0, 4), png.subarray(4)),
    });

    expect(uploaded).toEqual({
      created: true,
      descriptor: {
        id: attachmentId,
        name: "diagram.png",
        mediaType: "image/png",
        sizeBytes: png.byteLength,
        kind: "image",
      },
    });
    const contentPath = getAttachmentContentPath(
      TEST_ROOT,
      ROOT_SESSION_ID,
      attachmentId,
    );
    expect(await Bun.file(contentPath).bytes()).toEqual(png);
    const directoryNames = await readdir(join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID));
    expect(directoryNames).toEqual([attachmentId]);
    expect(contentPath).not.toContain("diagram.png");
    const metadata = await Bun.file(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID, attachmentId, "metadata.json"),
    ).json() as Record<string, unknown>;
    expect(metadata.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(uploaded.descriptor).not.toHaveProperty("digest");
  });

  test("accepts an empty attachment without Content-Length", async () => {
    const attachmentId = crypto.randomUUID();
    const uploaded = await service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "empty.txt",
      sizeBytes: 0,
      mediaType: undefined,
      body: null,
    });

    expect(uploaded.descriptor).toMatchObject({
      mediaType: "application/octet-stream",
      sizeBytes: 0,
      kind: "file",
    });
    expect(await Bun.file(getAttachmentContentPath(TEST_ROOT, ROOT_SESSION_ID, attachmentId)).bytes())
      .toHaveLength(0);
  });

  test("normalizes only a valid display media type and never trusts it for kind", async () => {
    const attachmentId = crypto.randomUUID();
    const uploaded = await uploadBytes({
      attachmentId,
      name: "fake.png",
      bytes: new TextEncoder().encode("not a png"),
      mediaType: "IMAGE/PNG; charset=utf-8",
    });
    expect(uploaded.descriptor).toMatchObject({
      mediaType: "image/png",
      kind: "file",
    });

    const invalidType = await uploadBytes({
      attachmentId: crypto.randomUUID(),
      name: "data.bin",
      bytes: Uint8Array.of(1),
      mediaType: "not a media type",
    });
    expect(invalidType.descriptor.mediaType).toBe("application/octet-stream");
  });

  test("recognizes PDF bytes and never trusts a declared PDF type for inline delivery", async () => {
    const pdf = await uploadBytes({
      attachmentId: crypto.randomUUID(),
      name: "brief.pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\nfixture"),
      mediaType: "text/plain",
    });
    expect(pdf.descriptor).toMatchObject({
      mediaType: "application/pdf",
      kind: "file",
    });

    const forged = await uploadBytes({
      attachmentId: crypto.randomUUID(),
      name: "forged.pdf",
      bytes: new TextEncoder().encode("<html>active content</html>"),
      mediaType: "application/pdf",
    });
    expect(forged.descriptor.mediaType).toBe("application/octet-stream");
  });

  test("recognizes JPEG, GIF87a, GIF89a, and WebP only at fixed offsets", async () => {
    const cases = [
      { bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0), mediaType: "image/jpeg" },
      { bytes: new TextEncoder().encode("GIF87a!"), mediaType: "image/gif" },
      { bytes: new TextEncoder().encode("GIF89a!"), mediaType: "image/gif" },
      { bytes: new TextEncoder().encode("RIFF1234WEBP"), mediaType: "image/webp" },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const result = await uploadBytes({
        attachmentId: crypto.randomUUID(),
        name: `image-${index}`,
        bytes: fixture.bytes,
        mediaType: "application/octet-stream",
      });
      expect(result.descriptor).toMatchObject({
        kind: "image",
        mediaType: fixture.mediaType,
      });
    }

    const shifted = await uploadBytes({
      attachmentId: crypto.randomUUID(),
      name: "shifted",
      bytes: Uint8Array.of(0, 0xff, 0xd8, 0xff),
      mediaType: "image/jpeg",
    });
    expect(shifted.descriptor.kind).toBe("file");
  });

  test("rejects invalid names and UUIDs before creating storage", async () => {
    const invalidNames = [
      "",
      "   ",
      ".",
      "..",
      "a/b",
      "a\\b",
      "nul\0name",
      "line\nbreak",
      "a".repeat(256),
      "你".repeat(86),
    ];
    for (const name of invalidNames) {
      await expect(service.upload({
        workspaceRoot: TEST_ROOT,
        rootSessionId: ROOT_SESSION_ID,
        attachmentId: crypto.randomUUID(),
        name,
        sizeBytes: 0,
        body: null,
      })).rejects.toBeInstanceOf(AttachmentValidationError);
    }
    await expect(service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: "../escape",
      name: "safe",
      sizeBytes: 0,
      body: null,
    })).rejects.toBeInstanceOf(AttachmentValidationError);
    expect(await Bun.file(join(TEST_ROOT, ".archcode", "runtime", "attachments")).exists()).toBe(false);
  });

  test("enforces declared size and Content-Length before or during streaming", async () => {
    await expect(service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: crypto.randomUUID(),
      name: "large",
      sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1,
      body: null,
    })).rejects.toBeInstanceOf(AttachmentTooLargeError);

    await expect(service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: crypto.randomUUID(),
      name: "mismatch",
      sizeBytes: 1,
      contentLength: 2,
      body: byteStream(Uint8Array.of(1)),
    })).rejects.toBeInstanceOf(AttachmentValidationError);

    const attachmentId = crypto.randomUUID();
    await expect(service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "short",
      sizeBytes: 2,
      body: byteStream(Uint8Array.of(1)),
    })).rejects.toBeInstanceOf(AttachmentValidationError);
    expect(await Bun.file(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID, attachmentId),
    ).exists()).toBe(false);
  });

  test("cleans its temp when the incoming stream aborts", async () => {
    const attachmentId = crypto.randomUUID();
    let pullCount = 0;
    await expect(service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "aborted.bin",
      sizeBytes: 2,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount++ === 0) {
            controller.enqueue(Uint8Array.of(1));
            return;
          }
          controller.error(new Error("client disconnected"));
        },
      }),
    })).rejects.toThrow("client disconnected");
    expect(await Bun.file(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID, attachmentId),
    ).exists()).toBe(false);
    expect((await readdir(join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID)))
      .some((entry) => entry.startsWith(`.${attachmentId}.tmp-`))).toBe(false);
  });

  test("cleans content when metadata persistence fails", async () => {
    const attachmentId = crypto.randomUUID();
    const write = spyOn(Bun, "write").mockRejectedValueOnce(new Error("metadata write failed"));
    try {
      await expect(uploadBytes({
        attachmentId,
        name: "metadata-failure.bin",
        bytes: Uint8Array.of(1),
        mediaType: "application/octet-stream",
      })).rejects.toThrow("metadata write failed");
    } finally {
      write.mockRestore();
    }
    expect(await Bun.file(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID, attachmentId),
    ).exists()).toBe(false);
    expect((await readdir(join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID)))
      .some((entry) => entry.startsWith(`.${attachmentId}.tmp-`))).toBe(false);
  });

  test("cleans its temp when the streaming file writer fails", async () => {
    const attachmentId = crypto.randomUUID();
    const originalFile = Bun.file.bind(Bun);
    const file = spyOn(Bun, "file").mockImplementation(((path: string, options?: unknown) => {
      const target = originalFile(path, options as never);
      if (
        path.endsWith("/content")
        && path.includes(`.${attachmentId}.tmp-`)
      ) {
        return new Proxy(target, {
          get(current, property, receiver) {
            if (property === "writer") {
              return () => ({
                write() {
                  throw new Error("disk write failed");
                },
                end() {},
              });
            }
            return Reflect.get(current, property, receiver);
          },
        });
      }
      return target;
    }) as typeof Bun.file);
    try {
      await expect(uploadBytes({
        attachmentId,
        name: "write-failure.bin",
        bytes: Uint8Array.of(1),
        mediaType: "application/octet-stream",
      })).rejects.toThrow("disk write failed");
    } finally {
      file.mockRestore();
    }
    expect(await Bun.file(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID, attachmentId),
    ).exists()).toBe(false);
    expect((await readdir(join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID)))
      .some((entry) => entry.startsWith(`.${attachmentId}.tmp-`))).toBe(false);
  });

  test("accepts exactly 50 MiB and rejects the next streamed byte with 413 semantics", async () => {
    const exactId = crypto.randomUUID();
    const exact = await service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: exactId,
      name: "exact-limit.bin",
      sizeBytes: MAX_ATTACHMENT_SIZE_BYTES,
      body: sizedByteStream(MAX_ATTACHMENT_SIZE_BYTES),
    });
    expect(exact.descriptor.sizeBytes).toBe(MAX_ATTACHMENT_SIZE_BYTES);

    const tooLargeId = crypto.randomUUID();
    await expect(service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: tooLargeId,
      name: "over-limit.bin",
      sizeBytes: MAX_ATTACHMENT_SIZE_BYTES,
      body: sizedByteStream(MAX_ATTACHMENT_SIZE_BYTES + 1),
    })).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(await Bun.file(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID, tooLargeId),
    ).exists()).toBe(false);
  });

  test("replays identical content and conflicts without overwriting on any identity change", async () => {
    const attachmentId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("same bytes");
    const original = await uploadBytes({
      attachmentId,
      name: "same.txt",
      bytes,
      mediaType: "text/plain",
    });
    const replay = await uploadBytes({
      attachmentId,
      name: "same.txt",
      bytes,
      mediaType: "text/plain",
    });
    expect(replay).toEqual({ ...original, created: false });

    await expect(uploadBytes({
      attachmentId,
      name: "same.txt",
      bytes: new TextEncoder().encode("diff bytes"),
      mediaType: "text/plain",
    })).rejects.toBeInstanceOf(AttachmentConflictError);
    expect(await Bun.file(getAttachmentContentPath(TEST_ROOT, ROOT_SESSION_ID, attachmentId)).text())
      .toBe("same bytes");
  });

  test("serializes concurrent same-ID uploads before the second body is read", async () => {
    const attachmentId = crypto.randomUUID();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    let secondBodyRead = false;
    const first = service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "concurrent.bin",
      sizeBytes: 1,
      body: observedByteStream(Uint8Array.of(7), async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
      }),
    });
    await firstStarted.promise;
    const second = service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "concurrent.bin",
      sizeBytes: 1,
      body: observedByteStream(Uint8Array.of(7), () => {
        secondBodyRead = true;
        secondStarted.resolve();
      }),
    });
    await Promise.resolve();
    expect(secondBodyRead).toBe(false);
    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await secondStarted.promise;
    expect([firstResult.created, secondResult.created]).toEqual([true, false]);
  });

  test("a failed same-ID request cleans only itself and the serialized retry completes", async () => {
    const attachmentId = crypto.randomUUID();
    let firstPull = 0;
    const failed = service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
      name: "serialized-retry.bin",
      sizeBytes: 2,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (firstPull++ === 0) {
            controller.enqueue(Uint8Array.of(1));
          } else {
            controller.error(new Error("first request failed"));
          }
        },
      }),
    });
    const retry = uploadBytes({
      attachmentId,
      name: "serialized-retry.bin",
      bytes: Uint8Array.of(1, 2),
      mediaType: "application/octet-stream",
    });
    await expect(failed).rejects.toThrow("first request failed");
    await expect(retry).resolves.toMatchObject({ created: true });
    expect(await Bun.file(getAttachmentContentPath(TEST_ROOT, ROOT_SESSION_ID, attachmentId)).bytes())
      .toEqual(Uint8Array.of(1, 2));
  });

  test("reports corruption when an existing object's digest drifted on replay", async () => {
    const attachmentId = crypto.randomUUID();
    const original = new TextEncoder().encode("original");
    await uploadBytes({
      attachmentId,
      name: "stable.txt",
      bytes: original,
      mediaType: "text/plain",
    });
    await Bun.write(
      getAttachmentContentPath(TEST_ROOT, ROOT_SESSION_ID, attachmentId),
      new TextEncoder().encode("modified"),
    );

    await expect(uploadBytes({
      attachmentId,
      name: "stable.txt",
      bytes: original,
      mediaType: "text/plain",
    })).rejects.toBeInstanceOf(AttachmentCorruptedError);
  });

  test("removes only same-ID service-named stale temp before retry", async () => {
    const attachmentId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const root = join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID);
    const stale = join(root, `.${attachmentId}.tmp-${crypto.randomUUID()}`);
    const other = join(root, `.${otherId}.tmp-${crypto.randomUUID()}`);
    await mkdir(stale, { recursive: true });
    await mkdir(other, { recursive: true });

    await uploadBytes({
      attachmentId,
      name: "retry.txt",
      bytes: Uint8Array.of(1),
      mediaType: "application/octet-stream",
    });
    expect(await Bun.file(stale).exists()).toBe(false);
    expect((await lstat(other)).isDirectory()).toBe(true);
  });

  test("rejects symlinked storage ancestors and content", async () => {
    const outside = join(TEST_ROOT, "outside");
    await mkdir(join(TEST_ROOT, ".archcode", "runtime"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(TEST_ROOT, ".archcode", "runtime", "attachments"));
    await expect(uploadBytes({
      attachmentId: crypto.randomUUID(),
      name: "blocked",
      bytes: Uint8Array.of(1),
      mediaType: "application/octet-stream",
    })).rejects.toBeInstanceOf(AttachmentPathSafetyError);

    await rm(join(TEST_ROOT, ".archcode"), { recursive: true, force: true });
    const attachmentId = crypto.randomUUID();
    await uploadBytes({
      attachmentId,
      name: "safe",
      bytes: Uint8Array.of(1),
      mediaType: "application/octet-stream",
    });
    const contentPath = getAttachmentContentPath(TEST_ROOT, ROOT_SESSION_ID, attachmentId);
    await rm(contentPath);
    await symlink(join(TEST_ROOT, "missing-target"), contentPath);
    await expect(service.openDownload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
    })).rejects.toBeInstanceOf(AttachmentPathSafetyError);
  });

  test("verified reads reject descriptor or digest drift", async () => {
    const attachmentId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("verified");
    const uploaded = await uploadBytes({
      attachmentId,
      name: "verified.txt",
      bytes,
      mediaType: "text/plain",
    });
    const verified = await service.readVerified({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
    }, uploaded.descriptor);
    expect(verified.bytes).toEqual(bytes);

    await expect(service.readVerified({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
    }, { ...uploaded.descriptor, name: "changed.txt" })).rejects
      .toBeInstanceOf(AttachmentCorruptedError);
  });

  test("read-path resolution requires the durable descriptor and a regular contained file", async () => {
    const attachmentId = crypto.randomUUID();
    const uploaded = await uploadBytes({
      attachmentId,
      name: "authorized.txt",
      bytes: new TextEncoder().encode("authorized"),
      mediaType: "text/plain",
    });
    await expect(service.resolveReadPath({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
    }, uploaded.descriptor)).resolves.toBe(
      getAttachmentContentPath(await realpath(TEST_ROOT), ROOT_SESSION_ID, attachmentId),
    );
    await expect(service.resolveReadPath({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
    }, { ...uploaded.descriptor, name: "drifted.txt" })).rejects
      .toBeInstanceOf(AttachmentCorruptedError);

    const contentPath = getAttachmentContentPath(TEST_ROOT, ROOT_SESSION_ID, attachmentId);
    await rm(contentPath);
    await symlink(join(TEST_ROOT, "outside-content"), contentPath);
    await expect(service.resolveReadPath({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId,
    }, uploaded.descriptor)).rejects.toBeInstanceOf(AttachmentPathSafetyError);
  });

  test("root deletion waits for an upload and blocks late recreation", async () => {
    const firstRead = deferred<void>();
    const releaseBody = deferred<void>();
    const firstId = crypto.randomUUID();
    const firstUpload = service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: firstId,
      name: "first",
      sizeBytes: 1,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          firstRead.resolve();
          await releaseBody.promise;
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        },
      }),
    });
    await firstRead.promise;

    let deleteEntered = false;
    const releaseDelete = deferred<void>();
    const deletion = service.withRootDeletionLease(
      TEST_ROOT,
      ROOT_SESSION_ID,
      async () => {
        deleteEntered = true;
        rootExists = false;
        await releaseDelete.promise;
      },
    );
    await Promise.resolve();
    expect(deleteEntered).toBe(false);
    releaseBody.resolve();
    await firstUpload;
    await waitFor(() => deleteEntered);

    const lateUpload = service.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      attachmentId: crypto.randomUUID(),
      name: "late",
      sizeBytes: 0,
      body: null,
    });
    releaseDelete.resolve();
    await deletion;
    await expect(lateUpload).rejects.toThrow("missing root");
    expect((await lstat(
      join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID),
    )).isDirectory()).toBe(true);
  });

  test("cleanup removes only the selected root directory", async () => {
    const otherRoot = crypto.randomUUID();
    await uploadBytes({
      attachmentId: crypto.randomUUID(),
      name: "owned",
      bytes: Uint8Array.of(1),
      mediaType: "application/octet-stream",
    });
    const otherService = new SessionAttachmentService({
      storage: new ProjectAttachmentStorage(),
      validateRootSession: async () => undefined,
    });
    await otherService.upload({
      workspaceRoot: TEST_ROOT,
      rootSessionId: otherRoot,
      attachmentId: crypto.randomUUID(),
      name: "other",
      sizeBytes: 0,
      body: null,
    });

    await service.cleanupRootAttachments(TEST_ROOT, ROOT_SESSION_ID);
    expect(await Bun.file(join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", ROOT_SESSION_ID)).exists())
      .toBe(false);
    expect((await lstat(join(TEST_ROOT, ".archcode", "runtime", "attachments", "sessions", otherRoot))).isDirectory())
      .toBe(true);
  });
});

function uploadBytes(input: {
  readonly attachmentId: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}) {
  return service.upload({
    workspaceRoot: TEST_ROOT,
    rootSessionId: ROOT_SESSION_ID,
    attachmentId: input.attachmentId,
    name: input.name,
    sizeBytes: input.bytes.byteLength,
    mediaType: input.mediaType,
    body: byteStream(input.bytes),
  });
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function sizedByteStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let remaining = totalBytes;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size = Math.min(remaining, chunk.byteLength);
      controller.enqueue(size === chunk.byteLength ? chunk : chunk.subarray(0, size));
      remaining -= size;
    },
  });
}

function observedByteStream(
  bytes: Uint8Array,
  beforeFirstRead: () => void | Promise<void>,
): ReadableStream<Uint8Array> {
  let delivered = false;
  return {
    getReader() {
      return {
        async read() {
          if (delivered) return { done: true, value: undefined };
          await beforeFirstRead();
          delivered = true;
          return { done: false, value: bytes };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("Timed out waiting for condition");
}
