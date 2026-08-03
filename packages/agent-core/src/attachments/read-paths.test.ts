import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { AttachmentDescriptor } from "@archcode/protocol";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { resolveCommittedAttachmentReadPaths } from "./read-paths";

const WORKSPACE = join("/tmp", "archcode-attachment-read-paths");

function descriptor(name: string): AttachmentDescriptor {
  return {
    id: crypto.randomUUID(),
    name,
    mediaType: "application/octet-stream",
    sizeBytes: 4,
    kind: "file",
  };
}

describe("resolveCommittedAttachmentReadPaths", () => {
  test("authorizes only consistent completed canonical attachment parts", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = crypto.randomUUID();
    const store = manager.create(rootSessionId, WORKSPACE, { source: { kind: "direct" }, agentName: "lead" });
    const committed = descriptor("committed.bin");
    const pending = descriptor("pending.bin");
    const incomplete = descriptor("incomplete.bin");
    const drifted = descriptor("drifted.bin");

    store.getState().append({
      type: "session.message_accepted",
      message: {
        id: "pending",
        clientRequestId: "pending-request",
        content: "",
        attachments: [pending],
        source: "user",
        state: "queued",
        revision: 0,
        acceptedAt: 1,
        updatedAt: 1,
        requestedModelSelection: {
          mode: "profile_default",
          selection: { model: "test:model" },
        },
      },
    });
    store.getState().append({
      type: "session.messages_committed",
      executionId: "execution",
      messages: [{
        id: "canonical",
        role: "user",
        createdAt: 2,
        completedAt: 2,
        parts: [
          { type: "attachment", id: "part-1", attachment: committed, createdAt: 2, completedAt: 2 },
          { type: "attachment", id: "part-2", attachment: incomplete, createdAt: 2 },
          { type: "attachment", id: "part-3", attachment: drifted, createdAt: 2, completedAt: 2 },
          {
            type: "attachment",
            id: "part-4",
            attachment: { ...drifted, sizeBytes: 5 },
            createdAt: 2,
            completedAt: 2,
          },
        ],
      }],
    });

    const resolveReadPath = mock(async (
      input: { attachmentId: string },
      expected: AttachmentDescriptor,
    ) => join(WORKSPACE, input.attachmentId, expected.name));
    const paths = await resolveCommittedAttachmentReadPaths({
      workspaceRoot: WORKSPACE,
      rootSessionId,
      storeManager: manager,
      attachments: { resolveReadPath },
    });

    expect([...paths]).toEqual([join(WORKSPACE, committed.id, committed.name)]);
    expect(resolveReadPath).toHaveBeenCalledTimes(1);
    expect(resolveReadPath.mock.calls[0]?.[1]).toEqual(committed);
  });

  test("omits objects rejected by storage validation", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = crypto.randomUUID();
    const store = manager.create(rootSessionId, WORKSPACE, { source: { kind: "direct" }, agentName: "lead" });
    const committed = descriptor("missing.bin");
    store.getState().append({
      type: "session.messages_committed",
      executionId: "execution",
      messages: [{
        id: "canonical",
        role: "user",
        createdAt: 2,
        completedAt: 2,
        parts: [{
          type: "attachment",
          id: "part",
          attachment: committed,
          createdAt: 2,
          completedAt: 2,
        }],
      }],
    });

    const paths = await resolveCommittedAttachmentReadPaths({
      workspaceRoot: WORKSPACE,
      rootSessionId,
      storeManager: manager,
      attachments: {
        async resolveReadPath() {
          throw new Error("unsafe");
        },
      },
    });
    expect(paths.size).toBe(0);
  });
});
