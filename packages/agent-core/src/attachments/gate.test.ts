import { describe, expect, test } from "bun:test";
import { SessionAttachmentRootGate } from "./gate";

describe("SessionAttachmentRootGate", () => {
  test("serializes concurrent delete leases", async () => {
    const gate = new SessionAttachmentRootGate();
    const releaseFirst = deferred<void>();
    const firstEntered = deferred<void>();
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const first = gate.withDelete("root", async () => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      firstEntered.resolve();
      await releaseFirst.promise;
      activeDeletes -= 1;
    });
    await firstEntered.promise;
    const second = gate.withDelete("root", async () => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      activeDeletes -= 1;
    });
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(maxActiveDeletes).toBe(1);
  });

  test("retains gate identity while a woken upload still owns a reference", async () => {
    const gate = new SessionAttachmentRootGate();
    const releaseDelete = deferred<void>();
    const deleteEntered = deferred<void>();
    const firstDelete = gate.withDelete("root", async () => {
      deleteEntered.resolve();
      await releaseDelete.promise;
    });
    await deleteEntered.promise;

    const uploadEntered = deferred<void>();
    const releaseUpload = deferred<void>();
    const upload = gate.withUpload("root", async () => {
      uploadEntered.resolve();
      await releaseUpload.promise;
    });
    releaseDelete.resolve();
    await firstDelete;
    await uploadEntered.promise;

    let secondDeleteEntered = false;
    const secondDelete = gate.withDelete("root", async () => {
      secondDeleteEntered = true;
    });
    await Promise.resolve();
    expect(secondDeleteEntered).toBe(false);
    releaseUpload.resolve();
    await Promise.all([upload, secondDelete]);
    expect(secondDeleteEntered).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
