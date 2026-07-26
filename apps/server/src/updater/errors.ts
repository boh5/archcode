export type UpdateErrorCode =
  | "UPDATE_BUSY"
  | "UPDATE_CHECK_FAILED"
  | "UPDATE_DOWNLOAD_FAILED"
  | "UPDATE_MANIFEST_INVALID"
  | "UPDATE_ATTESTATION_INVALID"
  | "UPDATE_UNSUPPORTED_PLATFORM"
  | "UPDATE_UNMANAGED_INSTALL"
  | "UPDATE_RECEIPT_MISMATCH"
  | "UPDATE_INCOMPATIBLE"
  | "UPDATE_ARCHIVE_INVALID"
  | "UPDATE_INSTALL_FAILED"
  | "UPDATE_NOT_AVAILABLE"
  | "UPDATE_RESTART_UNAVAILABLE"
  | "UPDATE_RUNTIME_BUSY";

export class UpdateError extends Error {
  constructor(
    public readonly code: UpdateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpdateError";
  }
}
