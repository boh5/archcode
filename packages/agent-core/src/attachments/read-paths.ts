import type { AttachmentDescriptor, SessionMessage } from "@archcode/protocol";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionAttachmentService } from "./service";

type ResolveCurrentTodoReadPaths = (input: {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
}) => Promise<{
  readonly attachments: readonly AttachmentDescriptor[];
  resolveReadPath(descriptor: AttachmentDescriptor): Promise<string>;
} | undefined>;

export interface ResolveAttachmentReadPathsInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly storeManager: SessionStoreManager;
  readonly attachments: Pick<SessionAttachmentService, "resolveReadPath">;
  readonly resolveCurrentTodoAttachments?: ResolveCurrentTodoReadPaths;
}

/** Resolves committed Session inputs plus the Todo references current at this tool boundary. */
export async function resolveAttachmentReadPaths(
  input: ResolveAttachmentReadPathsInput,
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

  try {
    const currentTodo = await input.resolveCurrentTodoAttachments?.({
      workspaceRoot: input.workspaceRoot,
      rootSessionId: input.rootSessionId,
    });
    if (currentTodo !== undefined) {
      for (const descriptor of currentTodo.attachments) {
        try {
          paths.add(await currentTodo.resolveReadPath(descriptor));
        } catch {
          // Invalid Todo objects must not widen the exact read exception.
        }
      }
    }
  } catch {
    // Missing or invalid Todo state must not widen the exact read exception.
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
