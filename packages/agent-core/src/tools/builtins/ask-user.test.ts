import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createSessionStore, storeManager } from "../../store/store";
import { getSessionHitlPath } from "../../store/sessions-dir";
import { askUserTool, AskUserInputSchema, executeAskUser } from "./ask-user";
import { createRegistry } from "../registry";
import type { AskUserCallback, AskUserQuestion, ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { SkillService } from "../../skills";
import { SessionHitlPause } from "../../execution/session-hitl-pause";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "ask-user");

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

const SINGLE_QUESTION: AskUserQuestion = {
  question: "What is your name?",
  header: "Name",
  options: [{ label: "Type your own answer", description: "Enter a custom response" }],
  custom: true,
};

const CUSTOM_ONLY_QUESTION: AskUserQuestion = {
  question: "What is your name?",
  header: "Name",
  options: [],
  custom: true,
};

const MULTI_QUESTIONS: AskUserQuestion[] = [
  {
    question: "Which file should I edit?",
    header: "File",
    options: [
      { label: "src/main.ts", description: "Main entry point" },
      { label: "src/utils.ts", description: "Utility functions" },
    ],
    custom: true,
  },
  {
    question: "What style do you prefer?",
    header: "Style",
    multiple: true,
    options: [
      { label: "Dark mode", description: "Dark color scheme" },
      { label: "Compact", description: "Compact layout" },
    ],
    custom: true,
  },
];

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const workspaceRoot = "/tmp/test";
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
    projectContext: createTestProjectContext(workspaceRoot),
    ...overrides,
  };
}

async function makeDurableCtx(overrides: Partial<ToolExecutionContext> = {}): Promise<ToolExecutionContext> {
  await mkdir(TMP_ROOT, { recursive: true });
  const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  const projectContext = createTestProjectContext(workspaceRoot);
  return makeCtx({
    store: createSessionStore(crypto.randomUUID(), workspaceRoot),
    cwd: workspaceRoot,
    projectContext,
    ...overrides,
  });
}

describe("AskUserInputSchema", () => {
  test("accepts valid input with single question", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [SINGLE_QUESTION],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid input with multiple questions", () => {
    const result = AskUserInputSchema.safeParse({
      questions: MULTI_QUESTIONS,
    });
    expect(result.success).toBe(true);
  });

  test("accepts question with multiple flag", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, multiple: true }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts question with custom flag", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, custom: false }],
    });
    expect(result.success).toBe(true);
  });

  test("defaults custom to true when omitted", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [SINGLE_QUESTION],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions[0].custom).toBe(true);
    }
  });

  test("accepts question with no options (custom only)", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [CUSTOM_ONLY_QUESTION],
    });
    expect(result.success).toBe(true);
  });

  test("defaults empty options array when options omitted", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ question: "Name?", header: "Name" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions[0].options).toEqual([]);
    }
  });

  test("rejects empty questions array", () => {
    const result = AskUserInputSchema.safeParse({ questions: [] });
    expect(result.success).toBe(false);
  });

  test("rejects question with empty question text", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, question: "" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects question with empty header", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, header: "" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects question with header exceeding 30 chars", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, header: "a".repeat(31) }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects option missing label", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, options: [{ description: "no label" } as any] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects option missing description", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, options: [{ label: "no desc" } as any] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects extra fields in top-level schema (strict mode)", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [SINGLE_QUESTION],
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  test("rejects extra fields in question schema (strict mode)", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, extraField: "nope" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects extra fields in option schema (strict mode)", () => {
    const result = AskUserInputSchema.safeParse({
      questions: [{ ...SINGLE_QUESTION, options: [{ label: "Yes", description: "Ok", extra: "nope" }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("executeAskUser", () => {
  test("creates durable Session HITL pause when askUser callback is missing", async () => {
    const ctx = await makeDurableCtx({ askUser: undefined });

    try {
      await executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);
      throw new Error("Expected ask_user to pause for Session HITL");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionHitlPause);
      if (!(error instanceof SessionHitlPause)) throw error;
      const pause = error;
      expect(pause.record.owner).toEqual({
        projectSlug: "test-project",
        ownerType: "session",
        ownerId: ctx.store.getState().sessionId,
      });
      expect(pause.record.source).toEqual({ type: "ask_user", sessionId: ctx.store.getState().sessionId, toolCallId: "call-1" });
      expect(pause.checkpoint).toMatchObject({ hitlId: pause.record.hitlId, toolCallId: "call-1", toolName: "ask_user" });

      const hitlFile = await Bun.file(getSessionHitlPath(
        ctx.projectContext.project.workspaceRoot,
        ctx.store.getState().sessionId,
      )).json() as { pending: Array<{ hitlId: string }> };
      expect(hitlFile.pending.map((record) => record.hitlId)).toContain(pause.record.hitlId);
    }
  });

  test("returns answers as tool result for single question", async () => {
    const askUser: AskUserCallback = async () => ({ answers: [["my answer"]] });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);

    expect(result).toEqual({ output: "my answer", isError: false });
  });

  test("returns structured answers for multiple questions", async () => {
    const askUser: AskUserCallback = async () => ({
      answers: [["src/main.ts"], ["Dark mode", "Compact"]],
    });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ questions: MULTI_QUESTIONS }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("File: src/main.ts");
    expect(result.output).toContain("Style: Dark mode, Compact");
  });

  test("returns isError when callback answers length mismatches questions", async () => {
    const askUser: AskUserCallback = async () => ({ answers: [["only one answer"]] });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ questions: MULTI_QUESTIONS }, ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.message).toContain("expected 2");
    expect(result.isError).toBe(true);
  });

  test("returns isError when callback answers contain empty array", async () => {
    const askUser: AskUserCallback = async () => ({ answers: [[], ["ok"]] });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ questions: MULTI_QUESTIONS }, ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.message).toContain("empty answer for question 1");
    expect(result.isError).toBe(true);
  });

  test("returns isError when user cancels", async () => {
    const askUser: AskUserCallback = async () => ({
      isError: true as const,
      reason: "Cancelled",
    });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.message).toBe("Cancelled");
    expect(parsed.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns isError with custom reason on duplicate pending", async () => {
    const askUser: AskUserCallback = async () => ({
      isError: true as const,
      reason: "Another question is already pending",
    });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.message).toBe("Another question is already pending");
    expect(parsed.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns isError when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const askUser: AskUserCallback = async () => ({ answers: [["should not reach"]] });
    const ctx = makeCtx({ askUser, abort: controller.signal });
    const result = await executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.message).toBe("ask_user was aborted");
    expect(parsed.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns isError when AbortSignal aborts while askUser is pending", async () => {
    const controller = new AbortController();
    const askUser: AskUserCallback = () => new Promise(() => {});
    const ctx = makeCtx({ askUser, abort: controller.signal });

    const pending = executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);
    controller.abort();

    const result = await pending;
    const parsed = JSON.parse(result.output);
    expect(parsed.message).toBe("ask_user was aborted");
    expect(parsed.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("passes correct request to askUser callback including abortSignal", async () => {
    let capturedRequest: Parameters<AskUserCallback>[0] | undefined;
    const askUser: AskUserCallback = async (req) => {
      capturedRequest = req;
      return { answers: [["yes"]] };
    };
    const signal = new AbortController().signal;
    const ctx = makeCtx({ askUser, toolName: "ask_user", toolCallId: "call-42", abort: signal });
    await executeAskUser({ questions: [SINGLE_QUESTION] }, ctx);

    expect(capturedRequest!).toEqual({
      toolName: "ask_user",
      toolCallId: "call-42",
      questions: [SINGLE_QUESTION],
      abortSignal: signal,
    });
  });

  test("registry rejects schema-invalid input", async () => {
    const registry = createRegistry([askUserTool]);
    const ctx = makeCtx({ askUser: async () => ({ answers: [["no"]] }) });
    const result = await registry.execute(
      { toolName: "ask_user", toolCallId: "call-1", input: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
  });

  test("tool not allowed when not in allowedTools set", async () => {
    const registry = createRegistry([askUserTool]);
    const askUser: AskUserCallback = async () => ({ answers: [["nope"]] });
    const ctx = makeCtx({ askUser, allowedTools: new Set(["other_tool"]) });
    const result = await registry.execute(
      { toolName: "ask_user", toolCallId: "call-1", input: { questions: [SINGLE_QUESTION] } },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not allowed");
  });
});
