import type { AttachmentModelProjector } from "./model-projector";

export const EMPTY_ATTACHMENT_MODEL_PROJECTOR: AttachmentModelProjector = {
  async project() {},
};

export async function resolveEmptyAttachmentReadPaths(): Promise<ReadonlySet<string>> {
  return new Set();
}
