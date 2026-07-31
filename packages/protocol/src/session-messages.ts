export const SESSION_MESSAGE_UNAVAILABLE_CODES = [
  "SESSION_FAMILY_ACTIVE",
  "SESSION_FAMILY_STOP_IN_PROGRESS",
  "SESSION_TOOL_BATCH_ACTIVE",
  "SESSION_COMMAND_CONFLICT",
] as const;

export type SessionMessageUnavailableCode =
  (typeof SESSION_MESSAGE_UNAVAILABLE_CODES)[number];

const SESSION_MESSAGE_UNAVAILABLE_CODE_SET = new Set<string>(
  SESSION_MESSAGE_UNAVAILABLE_CODES,
);

export function isSessionMessageUnavailableCode(
  value: unknown,
): value is SessionMessageUnavailableCode {
  return typeof value === "string"
    && SESSION_MESSAGE_UNAVAILABLE_CODE_SET.has(value);
}
