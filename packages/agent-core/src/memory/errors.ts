export type MemoryDomainErrorCode =
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_CAPACITY_EXCEEDED"
  | "MEMORY_INVALID_INPUT"
  | "MEMORY_SECRET_DETECTED";

export abstract class MemoryDomainError extends Error {
  abstract readonly code: MemoryDomainErrorCode;
}

export class MemoryRevisionConflictError extends MemoryDomainError {
  readonly code = "MEMORY_REVISION_CONFLICT" as const;
  readonly target: string;
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;

  constructor(target: string, expectedRevision: string | null, actualRevision: string | null) {
    super(`Memory revision conflict for ${target}`);
    this.name = "MemoryRevisionConflictError";
    this.target = target;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class MemoryCapacityError extends MemoryDomainError {
  readonly code = "MEMORY_CAPACITY_EXCEEDED" as const;
  readonly target: string;
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(target: string, bytes: number, maxBytes: number) {
    super(`Memory target ${target} exceeds its capacity (${bytes}/${maxBytes} bytes)`);
    this.name = "MemoryCapacityError";
    this.target = target;
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class MemoryValidationError extends MemoryDomainError {
  readonly code = "MEMORY_INVALID_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export class MemorySecretError extends MemoryDomainError {
  readonly code = "MEMORY_SECRET_DETECTED" as const;

  constructor() {
    super("Memory content contains a potential secret");
    this.name = "MemorySecretError";
  }
}
