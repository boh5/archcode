import type { AttachmentDescriptor, SessionMessage } from "@archcode/protocol";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionAttachmentService } from "./service";

export interface ResolveCommittedAttachmentReadPathsInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly storeManager: SessionStoreManager;
  readonly attachments: Pick<SessionAttachmentService, "resolveReadPath">;
}

/**
 * Resolves only attachment objects already committed to the root transcript.
 * Pending Queue input is intentionally absent from the canonical message list.
 */
export async function resolveCommittedAttachmentReadPaths(
  input: ResolveCommittedAttachmentReadPathsInput,
): Promise<ReadonlySet<string>> {
  const store = await input.storeManager.getOrLoad(
    input.rootSessionId,
    input.workspaceRoot,
  );
  const descriptors = collectConsistentDescriptors(store.getState().messages);
  const paths = new Set<string>();

  for (const descriptor of descriptors) {
    try {
      paths.add(await input.attachments.resolveReadPath({
        workspaceRoot: input.workspaceRoot,
        rootSessionId: input.rootSessionId,
        attachmentId: descriptor.id,
      }, descriptor));
    } catch {
      // Missing, unsafe, or drifted objects must not widen the read exception.
    }
  }

  return paths;
}

function collectConsistentDescriptors(
  messages: readonly SessionMessage[],
): AttachmentDescriptor[] {
  const byId = new Map<string, AttachmentDescriptor | undefined>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "attachment" || part.completedAt === undefined) continue;
      const previous = byId.get(part.attachment.id);
      if (previous === undefined && !byId.has(part.attachment.id)) {
        byId.set(part.attachment.id, part.attachment);
        continue;
      }
      if (previous === undefined || !sameDescriptor(previous, part.attachment)) {
        byId.set(part.attachment.id, undefined);
      }
    }
  }
  return [...byId.values()]
    .filter((descriptor): descriptor is AttachmentDescriptor => descriptor !== undefined)
    .map((descriptor) => ({ ...descriptor }));
}

function sameDescriptor(
  left: AttachmentDescriptor,
  right: AttachmentDescriptor,
): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.mediaType === right.mediaType
    && left.sizeBytes === right.sizeBytes
    && left.kind === right.kind;
}
