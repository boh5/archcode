import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { AttachmentPathSafetyError, AttachmentValidationError } from "./errors";

/** Pure lexical attachment path helper; storage reads return the canonical real path. */
export function getAttachmentContentPath(
  workspaceRoot: string,
  rootSessionId: string,
  attachmentId: string,
): string {
  if (!z.uuid().safeParse(attachmentId).success) {
    throw new AttachmentValidationError("attachmentId must be a UUID");
  }
  if (!isSafePathSegment(rootSessionId)) {
    throw new AttachmentPathSafetyError("root Session ID is not a safe path segment");
  }
  return join(
    resolve(workspaceRoot),
    ".archcode",
    "attachments",
    rootSessionId,
    attachmentId,
    "content",
  );
}

function isSafePathSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/\p{Cc}/u.test(value);
}
