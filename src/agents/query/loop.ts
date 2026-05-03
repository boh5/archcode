import { streamText as aiStreamText } from "ai";
import type { ModelMessage } from "ai";
import type { QueryLoopOptions, QueryLoopResult } from "./types.js";

const DEFAULT_MAX_STEPS = 50;

let _streamText: typeof aiStreamText = aiStreamText;

export function __setStreamTextForTest(fn: typeof aiStreamText) {
  _streamText = fn;
}

export async function runQueryLoop(
  options: QueryLoopOptions,
  userMessage: string,
): Promise<QueryLoopResult> {
  const {
    model,
    tools,
    toolExecutors,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
  } = options;

  const messages: ModelMessage[] = [
    { role: "user", content: userMessage },
  ];

  let steps = 0;
  let lastText = "";

  while (steps <= maxSteps) {
    const streamOpts: Record<string, unknown> = {
      model,
      messages,
    };
    if (Object.keys(tools).length > 0) {
      streamOpts.tools = tools;
    }
    if (systemPrompt) {
      streamOpts.system = systemPrompt;
    }

    const result = _streamText(
      streamOpts as Parameters<typeof aiStreamText>[0],
    );

    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        process.stdout.write(chunk.text);
      }
      if (chunk.type === "tool-call") {
        console.log(`\n[tool-call] ${chunk.toolName}`);
      }
    }

    const responseMessages = (await result.response).messages;
    messages.push(...responseMessages);

    lastText = await result.text;
    const finishReason = await result.finishReason;

    if (finishReason !== "tool-calls") {
      break;
    }

    if (steps >= maxSteps) {
      break;
    }

    const toolCalls = await result.toolCalls;

    const toolResultMessages = await Promise.all(
      toolCalls.map(async (tc) => {
        const executor = toolExecutors[tc.toolName] as
          | ((input: unknown) => Promise<string>)
          | undefined;
        if (!executor) {
          console.log(`[tool-error] No executor for tool: ${tc.toolName}`);
          return null;
        }
        const output = await executor(tc.input);
        console.log(`[tool-result] ${tc.toolName}: ${output}`);
        return {
          role: "tool" as const,
          content: [
            {
              toolName: tc.toolName,
              toolCallId: tc.toolCallId,
              type: "tool-result" as const,
              output: { type: "text" as const, value: output },
            },
          ],
        } satisfies ModelMessage;
      }),
    );

    for (const msg of toolResultMessages) {
      if (msg) messages.push(msg);
    }

    steps++;
  }

  return { text: lastText, messages, steps };
}
