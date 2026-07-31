import {
  AttachmentConflictError,
  AttachmentCorruptedError,
  AttachmentNotFoundError,
  AttachmentPathSafetyError,
  AttachmentTooLargeError,
  AttachmentValidationError,
  NotRootSessionError,
  SessionFileNotFoundError,
} from "@archcode/agent-core";
import { ServerError, SessionNotFoundError } from "../errors";

/** Maps attachment-domain failures at the HTTP boundary without owning storage policy. */
export function mapAttachmentHttpError(
  error: unknown,
  sessionId: string,
): Error | undefined {
  if (error instanceof AttachmentTooLargeError) {
    return new ServerError(
      "ATTACHMENT_TOO_LARGE",
      `Attachment exceeds the fixed ${error.limitBytes} byte limit`,
      413,
      { limitBytes: error.limitBytes },
    );
  }
  if (error instanceof AttachmentValidationError) {
    return new ServerError("ATTACHMENT_INVALID", error.message, 400);
  }
  if (error instanceof AttachmentConflictError) {
    return new ServerError(
      "ATTACHMENT_CONFLICT",
      error.message,
      409,
      { attachmentId: error.attachmentId },
    );
  }
  if (error instanceof AttachmentNotFoundError) {
    return new ServerError(
      "ATTACHMENT_NOT_FOUND",
      error.message,
      404,
      { attachmentId: error.attachmentId },
    );
  }
  if (error instanceof AttachmentCorruptedError) {
    return new ServerError(
      "ATTACHMENT_CORRUPTED",
      error.message,
      409,
      { attachmentId: error.attachmentId },
    );
  }
  if (error instanceof AttachmentPathSafetyError) {
    return new ServerError(
      "ATTACHMENT_PATH_UNSAFE",
      "Attachment storage path is unsafe",
      409,
    );
  }
  if (error instanceof NotRootSessionError) {
    return new ServerError(
      "ATTACHMENT_INVALID",
      `Session "${sessionId}" is not a user-facing root Session`,
      400,
    );
  }
  if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
    return new SessionNotFoundError(sessionId);
  }
  return undefined;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
