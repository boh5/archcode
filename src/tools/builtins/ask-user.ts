import { z } from "zod";
import { defineTool } from "../define-tool";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";

// ─── Input Schema ───

export const AskUserInputSchema = z
  .object({
    question: z.string().min(1),
  })
  .strict();

type AskUserInput = z.infer<typeof AskUserInputSchema>;

type AskUserResult = Awaited<ReturnType<NonNullable<ToolExecutionContext["askUser"]>>>;

// ─── Execute Logic ───

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
        question: input.question,
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

  if ("answer" in result) {
    return { output: result.answer, isError: false };
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
    "Asks the user a question and returns their answer. Use this tool when you need clarification or additional information from the user to proceed with a task. Only one question can be pending at a time.",
  inputSchema: AskUserInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: false },
  execute: async (input: AskUserInput, ctx: ToolExecutionContext) => {
    return executeAskUser(input, ctx);
  },
});
