import type { SessionAttachmentDescriptorResolver } from "./service";

export const EMPTY_SESSION_ATTACHMENT_RESOLVER: SessionAttachmentDescriptorResolver = {
  async resolveDescriptors({ attachmentIds }) {
    if (attachmentIds.length > 0) {
      throw new Error("This test resolver accepts only empty attachmentIds");
    }
    return [];
  },
};
