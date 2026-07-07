import { z } from "zod";
import { defineTool } from "../define-tool";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";
import { pauseForAskUser } from "../../execution/session-hitl-pause";
import { formatAskUserAnswers } from "./ask-user-format";

// ─── Input Schema ───

const AskUserQuestionOptionSchema = z.object({
  label: z.string().describe("Short display text (1-5 words)"),
  description: z.string().describe("Explanation of what this choice entails"),
}).strict();

const AskUserQuestionSchema = z.object({
  question: z.string().min(1).describe("The full question text"),
  header: z.string().min(1).max(30).describe("Very short label (max 30 chars) shown as the question heading"),
  options: z.array(AskUserQuestionOptionSchema).optional().default([]).describe("Available choices. Each option: { label, description }. Omit when custom=true for free-text only. If recommending an option, list it first with \"(Recommended)\" suffix."),
  multiple: z.boolean().optional().describe("Allow selecting more than one answer"),
  custom: z.boolean().optional().default(true).describe("When true (default), adds a 'Type your own answer' option automatically. Set false to force choosing from provided options only."),
}).strict();

export const AskUserInputSchema = z
  .object({
    questions: z.array(AskUserQuestionSchema).min(1).describe("Array of questions to ask. Each: { question, header, options?, multiple?, custom? }"),
  })
  .strict();

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

type AskUserResult = Awaited<ReturnType<NonNullable<ToolExecutionContext["askUser"]>>>;

// ─── Execute Logic ───

export async function executeAskUser(
  input: AskUserInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const askUser = ctx.askUser;
  if (!askUser) {
    await pauseForAskUser(input, ctx);
  }

  if (ctx.abort.aborted) {
    return createToolErrorResult({ kind: "cancelled", message: "ask_user was aborted" });
  }

  const abortRace = rejectOnAbort(ctx.abort);
  let result: AskUserResult;
  try {
    result = await Promise.race([
      askUser!({
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        questions: input.questions,
        abortSignal: ctx.abort,
      }),
      abortRace.promise,
    ]);
  } catch (err) {
    if (err instanceof AskUserAbortError) {
      return createToolErrorResult({ kind: "cancelled", message: "ask_user was aborted" });
    }
    throw err;
  } finally {
    abortRace.cleanup();
  }

  if ("answers" in result) {
    // Validate answers length matches questions
    if (result.answers.length !== input.questions.length) {
      return createToolErrorResult({
        kind: "cancelled",
        message: `ask_user received ${result.answers.length} answers but expected ${input.questions.length}`,
      });
    }
    // Validate no empty answers
    const emptyIndex = result.answers.findIndex((a) => a.length === 0);
    if (emptyIndex !== -1) {
      return createToolErrorResult({
        kind: "cancelled",
        message: `ask_user received empty answer for question ${emptyIndex + 1}`,
      });
    }
    const output = formatAskUserAnswers(result.answers, input.questions);
    return { output, isError: false };
  }

  return createToolErrorResult({ kind: "cancelled", message: result.reason });
}

class AskUserAbortError extends Error {
  constructor() {
    super("ask_user was aborted");
    this.name = "AskUserAbortError";
  }
}

function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new AskUserAbortError());
    cleanup = () => signal.removeEventListener("abort", onAbort);

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });

  return { promise, cleanup };
}

// ─── Tool Definition ───

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "Ask the user questions during execution. Use to gather preferences, clarify ambiguous instructions, or offer choices. When `custom` is enabled (default), a free-text answer option is added automatically.",
  inputSchema: AskUserInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: false },
  execute: async (input: AskUserInput, ctx: ToolExecutionContext) => {
    return executeAskUser(input, ctx);
  },
});
