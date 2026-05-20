import { z } from "zod";
import { defineTool } from "../define-tool";
import type { AskUserQuestionOption, ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";

// ─── Input Schema ───

const AskUserQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
}).strict();

const AskUserQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).max(30),
  options: z.array(AskUserQuestionOptionSchema).optional().default([]),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional().default(true),
}).strict();

export const AskUserInputSchema = z
  .object({
    questions: z.array(AskUserQuestionSchema).min(1),
  })
  .strict();

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

type AskUserResult = Awaited<ReturnType<NonNullable<ToolExecutionContext["askUser"]>>>;

// ─── Execute Logic ───

function formatAnswers(answers: string[][], questions: AskUserInput["questions"]): string {
  if (questions.length === 1) {
    const answer = answers[0];
    if (!answer || answer.length === 0) return "";
    return answer.join(", ");
  }

  const lines = questions.map((q, i) => {
    const answer = answers[i];
    if (!answer || answer.length === 0) return `${q.header}: `;
    return `${q.header}: ${answer.join(", ")}`;
  });
  return lines.join("\n");
}

export async function executeAskUser(
  input: AskUserInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!ctx.askUser) {
    return createToolErrorResult({ kind: "cancelled", message: "ask_user is not available" });
  }

  if (ctx.abort.aborted) {
    return createToolErrorResult({ kind: "cancelled", message: "ask_user was aborted" });
  }

  const abortRace = rejectOnAbort(ctx.abort);
  let result: AskUserResult;
  try {
    result = await Promise.race([
      ctx.askUser({
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
    const output = formatAnswers(result.answers, input.questions);
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
    "Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- When `custom` is enabled (default), a \"Type your own answer\" option is added automatically; don't include \"Other\" or catch-all options\n- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label\n- Set `custom: false` if the user must choose from the provided options only\n- The `options` array is optional when `custom` is true (free text only)",
  inputSchema: AskUserInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: false },
  execute: async (input: AskUserInput, ctx: ToolExecutionContext) => {
    return executeAskUser(input, ctx);
  },
});