export class AttachmentValidationError extends Error {
  readonly code = "ATTACHMENT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export class AttachmentTooLargeError extends Error {
  readonly code = "ATTACHMENT_TOO_LARGE";

  constructor(
    public readonly limitBytes: number,
    public readonly actualBytes?: number,
  ) {
    super(`Attachment exceeds the ${limitBytes} byte limit`);
    this.name = "AttachmentTooLargeError";
  }
}

export class AttachmentConflictError extends Error {
  readonly code = "ATTACHMENT_CONFLICT";

  constructor(public readonly attachmentId: string, message: string) {
    super(message);
    this.name = "AttachmentConflictError";
  }
}

export class AttachmentNotFoundError extends Error {
  readonly code = "ATTACHMENT_NOT_FOUND";

  constructor(public readonly attachmentId: string) {
    super(`Attachment not found: ${attachmentId}`);
    this.name = "AttachmentNotFoundError";
  }
}

export class AttachmentCorruptedError extends Error {
  readonly code = "ATTACHMENT_CORRUPTED";

  constructor(public readonly attachmentId: string, message: string) {
    super(message);
    this.name = "AttachmentCorruptedError";
  }
}

export class AttachmentPathSafetyError extends Error {
  readonly code = "ATTACHMENT_PATH_UNSAFE";

  constructor(message: string) {
    super(message);
    this.name = "AttachmentPathSafetyError";
  }
}
