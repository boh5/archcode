import type { AttachmentDescriptor } from "@archcode/protocol";
import type { ModelMessage } from "ai";
import {
  renderAttachmentMarker,
  type AttachmentMarkerPart,
  type AttachmentProjectionSlot,
} from "../store/projection";

type UserMessage = Extract<ModelMessage, { role: "user" }>;
type UserContent = Exclude<UserMessage["content"], string>;
type UserContentPart = UserContent[number];

export interface VerifiedAttachmentContent {
  readonly descriptor: AttachmentDescriptor;
  readonly contentPath: string;
  readonly bytes: Uint8Array;
}

export interface AttachmentContentReader {
  resolveReadPath(
    input: {
      readonly workspaceRoot: string;
      readonly rootSessionId: string;
      readonly attachmentId: string;
    },
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<string>;
  readVerified(
    input: {
      readonly workspaceRoot: string;
      readonly rootSessionId: string;
      readonly attachmentId: string;
    },
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<VerifiedAttachmentContent>;
}

export interface ProjectModelAttachmentsInput {
  readonly messages: ModelMessage[];
  readonly attachmentSlots: readonly AttachmentProjectionSlot[];
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly supportsImages: boolean;
}

/** Model-boundary attachment projection. It is the only attachment byte reader in model history. */
export interface AttachmentModelProjector {
  project(input: ProjectModelAttachmentsInput): Promise<void>;
}

export class SessionAttachmentModelProjector implements AttachmentModelProjector {
  readonly #reader: AttachmentContentReader;

  constructor(reader: AttachmentContentReader) {
    this.#reader = reader;
  }

  async project(input: ProjectModelAttachmentsInput): Promise<void> {
    for (const slot of input.attachmentSlots) {
      const location = findMarkerLocation(input.messages, slot.markerPart);
      if (location === undefined) continue;

      const readInput = {
        workspaceRoot: input.workspaceRoot,
        rootSessionId: input.rootSessionId,
        attachmentId: slot.descriptor.id,
      };
      const shouldReadImage = input.supportsImages && slot.descriptor.kind === "image";
      const verified = shouldReadImage
        ? await this.#reader.readVerified(readInput, slot.descriptor)
        : undefined;
      const contentPath = verified?.contentPath
        ?? await this.#reader.resolveReadPath(readInput, slot.descriptor);

      // The reader is asynchronous. Re-find by object identity before insertion
      // so a removed/replaced marker can never bind bytes to another part.
      const currentLocation = findMarkerLocation(input.messages, slot.markerPart);
      if (currentLocation === undefined) continue;
      slot.markerPart.text = renderAttachmentMarker(slot.descriptor, contentPath);
      if (verified === undefined) continue;
      const imagePart: UserContentPart = {
        type: "image",
        image: verified.bytes,
        mediaType: verified.descriptor.mediaType,
      };
      currentLocation.content.splice(currentLocation.index + 1, 0, imagePart);
    }
  }
}

function findMarkerLocation(
  messages: readonly ModelMessage[],
  markerPart: AttachmentMarkerPart,
): { readonly content: UserContent; readonly index: number } | undefined {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    const index = message.content.indexOf(markerPart);
    if (index >= 0) return { content: message.content, index };
  }
  return undefined;
}
