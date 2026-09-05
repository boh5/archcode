import { describe, expect, test } from "bun:test";
import {
  MAX_DIRECT_CHILD_SESSIONS,
  MAX_DELEGATED_SESSION_TITLE_LENGTH,
  MAX_SESSION_TODOS,
  MAX_SESSION_TODOS_SERIALIZED_BYTES,
  delegatedSessionTitleCapacityViolation,
  directChildContextCapacityViolation,
  sessionTodoCapacityViolation,
  utf8ByteLength,
  type SessionTodoCapacityCandidate,
  type DirectChildContextCapacityCandidate,
} from "./session-capacity";

function todo(
  content: string,
  id = "todo",
): SessionTodoCapacityCandidate {
  return { id, content, status: "pending" };
}

function aggregateAtLimit(): SessionTodoCapacityCandidate[] {
  const todos = [todo("")];
  const remaining = MAX_SESSION_TODOS_SERIALIZED_BYTES - utf8ByteLength(JSON.stringify(todos));
  return [{ ...todos[0]!, content: "x".repeat(remaining) }];
}

function child(
  overrides: Partial<DirectChildContextCapacityCandidate> = {},
): DirectChildContextCapacityCandidate {
  return {
    sessionId: "child",
    agentName: "explore",
    profile: "fast",
    title: "Inspect",
    executionId: "execution",
    status: "completed",
    ...overrides,
  };
}

describe("Session todo capacity", () => {
  test("accepts every exact boundary", () => {
    expect(sessionTodoCapacityViolation(
      Array.from({ length: MAX_SESSION_TODOS }, (_, index) => todo("ok", `todo-${index}`)),
    )).toBeUndefined();

    const aggregate = aggregateAtLimit();
    expect(utf8ByteLength(JSON.stringify(aggregate))).toBe(MAX_SESSION_TODOS_SERIALIZED_BYTES);
    expect(sessionTodoCapacityViolation(aggregate)).toBeUndefined();
  });

  test("rejects the first byte or item beyond every boundary", () => {
    expect(sessionTodoCapacityViolation(
      Array.from({ length: MAX_SESSION_TODOS + 1 }, (_, index) => todo("ok", `todo-${index}`)),
    )).toContain("items");

    const aggregate = aggregateAtLimit();
    const oversizedAggregate = aggregate.map((item, index) => index === aggregate.length - 1
      ? { ...item, content: `${item.content}x` }
      : item);
    expect(utf8ByteLength(JSON.stringify(oversizedAggregate))).toBe(MAX_SESSION_TODOS_SERIALIZED_BYTES + 1);
    expect(sessionTodoCapacityViolation(oversizedAggregate)).toContain("serializes to");
  });
});

describe("direct child Current Context capacity", () => {
  test("accepts all bounded fields and the final unique child", () => {
    const exactPointTitle = "t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH);
    expect(directChildContextCapacityViolation([child({ title: exactPointTitle })]))
      .toBeUndefined();

    const complete = Array.from({ length: MAX_DIRECT_CHILD_SESSIONS }, (_, index) => child({
      sessionId: `child-${index}`,
      executionId: `execution-${index}`,
      title: exactPointTitle,
    }));
    expect(directChildContextCapacityViolation(complete)).toBeUndefined();
  });

  test("rejects the first value beyond each field or collection boundary", () => {
    expect(directChildContextCapacityViolation([child({ agentName: "unknown" })]))
      .toContain("supported delegated Agent identity");
    expect(directChildContextCapacityViolation([child({ agentName: "lead" })]))
      .toContain("supported delegated Agent identity");
    expect(directChildContextCapacityViolation([child({ agentName: "discussion" })]))
      .toContain("supported delegated Agent identity");
    expect(directChildContextCapacityViolation([child({ profile: "principal" })]))
      .toContain("supported child Profile");
    expect(directChildContextCapacityViolation([child({ status: "unknown" })]))
      .toContain("supported link status");
    expect(directChildContextCapacityViolation([child({ title: "  " })]))
      .toContain("must not be blank");
    expect(directChildContextCapacityViolation([child({
      title: "t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH + 1),
    })])).toContain("Unicode code points");
    expect(directChildContextCapacityViolation(
      Array.from({ length: MAX_DIRECT_CHILD_SESSIONS + 1 }, () => child()),
    )).toContain("Sessions");
  });
});

describe("delegated Session title capacity", () => {
  test("accepts the exact code-point limit", () => {
    expect(delegatedSessionTitleCapacityViolation(
      "t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH),
    )).toBeUndefined();
  });

  test("rejects blank and limit-plus-one code points", () => {
    expect(delegatedSessionTitleCapacityViolation(" ")).toContain("must not be blank");
    expect(delegatedSessionTitleCapacityViolation(
      "t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH + 1),
    )).toContain("Unicode code points");
  });
});
