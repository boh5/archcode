import {
  DELEGATED_AGENT_NAMES,
  DIRECT_CHILD_AGENT_PROFILES,
  TOOL_CHILD_SESSION_LINK_STATUSES,
  type ToolChildSessionLink,
} from "./types";

/** Maximum number of checklist items retained in one Session. */
export const MAX_SESSION_TODOS = 32;

/** Maximum serialized UTF-8 size of the complete Session checklist. */
export const MAX_SESSION_TODOS_SERIALIZED_BYTES = 24 * 1_024;

/** Maximum number of durable direct child Sessions owned by one parent. */
export const MAX_DIRECT_CHILD_SESSIONS = 64;

/** Maximum Unicode scalar count of a delegated child Session title. */
export const MAX_DELEGATED_SESSION_TITLE_LENGTH = 80;

export interface SessionTodoCapacityCandidate {
  readonly id: string;
  readonly content: string;
  readonly status: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface DirectChildContextCapacityCandidate {
  readonly sessionId: string;
  readonly agentName: string;
  readonly profile: string;
  readonly title: string;
  readonly executionId: string | null;
  readonly status: string;
}

const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function delegatedSessionTitleCapacityViolation(value: string): string | undefined {
  if (value.trim().length === 0) {
    return "Delegated Session title must not be blank";
  }
  const titleLength = Array.from(value).length;
  if (titleLength > MAX_DELEGATED_SESSION_TITLE_LENGTH) {
    return `Delegated Session title contains ${titleLength} Unicode code points; maximum is ${MAX_DELEGATED_SESSION_TITLE_LENGTH}`;
  }
  return undefined;
}

export function sessionTodoCapacityViolation(
  todos: readonly SessionTodoCapacityCandidate[],
): string | undefined {
  if (todos.length > MAX_SESSION_TODOS) {
    return `Session todo list contains ${todos.length} items; maximum is ${MAX_SESSION_TODOS}`;
  }

  const serializedBytes = utf8ByteLength(JSON.stringify(todos));
  if (serializedBytes > MAX_SESSION_TODOS_SERIALIZED_BYTES) {
    return `Session todo list serializes to ${serializedBytes} UTF-8 bytes; maximum is ${MAX_SESSION_TODOS_SERIALIZED_BYTES}`;
  }
  return undefined;
}

export function directChildContextCapacityViolation(
  children: readonly DirectChildContextCapacityCandidate[],
): string | undefined {
  if (children.length > MAX_DIRECT_CHILD_SESSIONS) {
    return `Direct child context contains ${children.length} Sessions; maximum is ${MAX_DIRECT_CHILD_SESSIONS}`;
  }

  for (const child of children) {
    if (!(DELEGATED_AGENT_NAMES as readonly string[]).includes(child.agentName)) {
      return `Direct child Agent name "${child.agentName}" is not a supported delegated Agent identity`;
    }
    if (!(DIRECT_CHILD_AGENT_PROFILES as readonly string[]).includes(child.profile)) {
      return `Direct child Profile "${child.profile}" is not a supported child Profile`;
    }
    if (!(TOOL_CHILD_SESSION_LINK_STATUSES as readonly string[]).includes(child.status)) {
      return `Direct child status "${child.status}" is not a supported link status`;
    }
    const titleViolation = delegatedSessionTitleCapacityViolation(child.title);
    if (titleViolation !== undefined) return titleViolation;
  }
  return undefined;
}

/**
 * Project the latest durable link for every unique direct child into the exact
 * six fields exposed in Current Context.
 */
export function projectLatestDirectChildContext(
  links: readonly ToolChildSessionLink[],
): DirectChildContextCapacityCandidate[] {
  const latest = new Map<string, ToolChildSessionLink>();
  for (const link of links) {
    const current = latest.get(link.childSessionId);
    if (
      current === undefined
      || link.createdAt > current.createdAt
      || (
        link.createdAt === current.createdAt
        && link.parentToolCallId.localeCompare(current.parentToolCallId) > 0
      )
    ) {
      latest.set(link.childSessionId, link);
    }
  }

  return [...latest.values()]
    .sort((left, right) => left.childSessionId.localeCompare(right.childSessionId))
    .map((link) => ({
      sessionId: link.childSessionId,
      agentName: link.childAgentName,
      profile: link.childProfile,
      title: link.title,
      executionId: link.childExecutionId,
      status: link.status,
    }));
}
