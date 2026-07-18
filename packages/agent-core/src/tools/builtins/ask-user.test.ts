import { describe, expect, test } from "bun:test";

import { HitlBoundaryCodec, ProjectHitlQueue } from "../../hitl";
import { createSessionStore, storeManager } from "../../store/store";
import { SkillService } from "../../skills";
import { createTestProjectContext } from "../test-project-context";
import type { ToolExecutionContext } from "../types";
import { REDACTION_MARKER, SecretRedactionPolicy } from "../../security";
import {
  AskUserInputSchema,
  askUserTool,
  prepareAskUserBlock,
  resumeAskUser,
  type AskUserInput,
} from "./ask-user";

const SINGLE_QUESTION: AskUserInput["questions"][number] = {
  question: "Which storage boundary should be used?",
  header: "Storage",
  options: [{ label: "Project file", description: "Keep the state with the workspace." }],
  custom: true,
};

function makeCtx(secretLiterals: string[] = []): ToolExecutionContext {
  const workspaceRoot = `/tmp/archcode-ask-user-${crypto.randomUUID()}`;
  const codec = new HitlBoundaryCodec(new SecretRedactionPolicy(secretLiterals));
  const baseProjectContext = createTestProjectContext(workspaceRoot);
  const projectContext = {
    ...baseProjectContext,
    hitl: new ProjectHitlQueue({ workspaceRoot, codec }),
  };
  return {
    store: createSessionStore(crypto.randomUUID(), workspaceRoot),
    toolName: "ask_user",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["ask_user"]),
    agentName: "engineer",
    agentSkills: [],
    skillService: new SkillService({ builtinSkills: {} }),
    cwd: workspaceRoot,
    storeManager,
    projectContext,
  };
}

describe("AskUserInputSchema", () => {
  test("accepts one to three bounded questions and applies defaults", () => {
    const parsed = AskUserInputSchema.parse({ questions: [{ question: "Choose?", header: "Choice" }] });
    expect(parsed.questions[0]).toMatchObject({ options: [], custom: true });
    expect(AskUserInputSchema.safeParse({ questions: Array.from({ length: 4 }, () => SINGLE_QUESTION) }).success).toBe(false);
    expect(AskUserInputSchema.safeParse({ questions: [{ ...SINGLE_QUESTION, options: Array.from({ length: 4 }, () => SINGLE_QUESTION.options[0]!) }] }).success).toBe(false);
    expect(AskUserInputSchema.safeParse({ questions: [{ ...SINGLE_QUESTION, question: "q".repeat(2 * 1024 + 1) }] }).success).toBe(false);
  });

  test("keeps the strict question and option contract at the suspension boundary", () => {
    expect(AskUserInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(AskUserInputSchema.safeParse({ questions: [{ ...SINGLE_QUESTION, options: [{ label: "only label" }] }] }).success).toBe(false);
    expect(AskUserInputSchema.safeParse({ questions: [SINGLE_QUESTION], old_callback_field: true }).success).toBe(false);
  });
});
describe("ask_user suspend and resume", () => {
  test("initial invocation prepares one bounded blocked request and never executes", () => {
    const ctx = makeCtx();
    const input = { questions: [SINGLE_QUESTION] };
    const blocked = prepareAskUserBlock(input, ctx);

    expect(blocked).toMatchObject({
      source: { type: "ask_user", toolCallId: "call-1" },
      displayPayload: { title: "Storage", redacted: true },
    });
    expect(askUserTool.prepareBlock).toBeDefined();
    expect(askUserTool.resume).toBeDefined();
    expect(() => askUserTool.execute(input, ctx)).toThrow("must suspend via prepareBlock");
  });

  test("resume accepts a matching answer and returns raw output with bounded presentation", () => {
    const result = resumeAskUser(
      { questions: [SINGLE_QUESTION] },
      { type: "question_answer", answers: ["Project file"] },
      makeCtx(),
    );

    expect(result).toMatchObject({
      isError: false,
      draft: { kind: "text" },
      details: {
        presentations: [{
          kind: "ask_user",
          answers: [{ question: SINGLE_QUESTION.question, answers: ["Project file"] }],
        }],
      },
    });
  });

  test("resume accepts cancel as a bounded error and rejects mismatched decisions", () => {
    const ctx = makeCtx();
    const cancelled = resumeAskUser(
      { questions: [SINGLE_QUESTION] },
      { type: "cancel", reason: "Not now" },
      ctx,
    );
    expect(cancelled.isError).toBe(true);
    expect(() => resumeAskUser(
      { questions: [SINGLE_QUESTION] },
      { type: "permission_decision", decision: "approve_once" },
      ctx,
    )).toThrow("does not answer ask_user");
  });

  test("resume rejects incomplete answers without returning a final result", () => {
    const input = { questions: [SINGLE_QUESTION, { ...SINGLE_QUESTION, header: "Second", question: "Second question?" }] };
    const result = resumeAskUser(input, { type: "question_answer", answers: ["only one"] }, makeCtx());
    expect(result).toMatchObject({ isError: true, details: { error: { code: "TOOL_CANCELLED" } } });
  });

  test("secret-bearing request and response continue with markers and no original value", () => {
    const secret = "literal-secret-value-123456";
    const ctx = makeCtx([secret]);
    const input = { questions: [{ ...SINGLE_QUESTION, question: `Use ${secret}?` }] };
    const blocked = prepareAskUserBlock(input, ctx);
    const result = resumeAskUser(input, { type: "question_answer", answers: [`Use ${secret}`] }, ctx);
    const serialized = JSON.stringify({ blocked, result });

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(REDACTION_MARKER);
  });
});
