export const MAX_ATTACHMENT_SIZE_BYTES = 52_428_800;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENTS_PER_TODO = 10;

const ATTACHMENT_MEDIA_TYPE_PATTERN =
  /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

export function isValidAttachmentName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/\p{Cc}/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 255;
}

export function isValidAttachmentMediaType(value: unknown): value is string {
  return typeof value === "string"
    && ATTACHMENT_MEDIA_TYPE_PATTERN.test(value)
    && new TextEncoder().encode(value).byteLength <= 127;
}

export interface AttachmentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "file";
}
