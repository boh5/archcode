import { streamText as aiStreamText } from "ai";
import type { ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import type { QueryLoopOptions, QueryLoopResult } from "./types.js";
import type {
  TranscriptEvent,
  UserMessageEvent,
  TextDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  LoopErrorEvent,
} from "../../store/types.js";

const DEFAULT_MAX_STEPS = 50;

let _streamText: typeof aiStreamText = aiStreamText;

export function __setStreamTextForTest(fn: typeof aiStreamText) {
  _streamText = fn;
}

type EventPayload =
  | Omit<UserMessageEvent, "id" | "timestamp">
  | Omit<TextDeltaEvent, "id" | "timestamp">
  | Omit<ToolCallEvent, "id" | "timestamp">
  | Omit<ToolResultEvent, "id" | "timestamp">
  | Omit<LoopErrorEvent, "id" | "timestamp">;

function appendEvent(
  store: QueryLoopOptions["store"],
  event: EventPayload,
): void {
  const enriched: TranscriptEvent = {
    ...event,
    id: randomUUID(),
    timestamp: Date.now(),
  } as TranscriptEvent;
  store.getState().append(enriched);
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
    store,
  } = options;

  const messages: ModelMessage[] = [
    { role: "user", content: userMessage },
  ];

  appendEvent(store, { type: "user-message", step: 0, content: userMessage });

  let steps = 0;
  let lastText = "";

  while (steps < maxSteps) {
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

    let result: Awaited<ReturnType<typeof aiStreamText>>;
    try {
      result = _streamText(
        streamOpts as Parameters<typeof aiStreamText>[0],
      );
    } catch (err) {
      appendEvent(store, { type: "loop-error", step: steps, error: String(err) });
      break;
    }

    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          appendEvent(store, { type: "text-delta", step: steps, text: chunk.text });
        }
        if (chunk.type === "tool-call") {
          appendEvent(store, {
            type: "tool-call",
            step: steps,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            input: chunk.input,
          });
        }
      }
    } catch (err) {
      appendEvent(store, { type: "loop-error", step: steps, error: String(err) });
      break;
    }

    let responseMessages: ModelMessage[];
    try {
      responseMessages = (await result.response).messages;
    } catch (err) {
      appendEvent(store, { type: "loop-error", step: steps, error: String(err) });
      break;
    }
    messages.push(...responseMessages);

    try {
      lastText = await result.text;
    } catch (err) {
      appendEvent(store, { type: "loop-error", step: steps, error: String(err) });
      break;
    }

    let finishReason: string;
    try {
      finishReason = await result.finishReason;
    } catch (err) {
      appendEvent(store, { type: "loop-error", step: steps, error: String(err) });
      break;
    }

    if (finishReason !== "tool-calls") {
      break;
    }

    let toolCalls: Awaited<typeof result.toolCalls>;
    try {
      toolCalls = await result.toolCalls;
    } catch (err) {
      appendEvent(store, { type: "loop-error", step: steps, error: String(err) });
      break;
    }

    const toolResultMessages = await Promise.all(
      toolCalls.map(async (tc) => {
        const executor = toolExecutors[tc.toolName] as
          | ((input: unknown) => Promise<string>)
          | undefined;

        if (!executor) {
          const errorMsg = `No executor for tool: ${tc.toolName}`;
          appendEvent(store, {
            type: "tool-result",
            step: steps,
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            output: errorMsg,
            isError: true,
          });
          // Must return a valid tool-result to keep the LLM message protocol intact
          return {
            role: "tool" as const,
            content: [
              {
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                type: "tool-result" as const,
                output: { type: "text" as const, value: errorMsg },
              },
            ],
          } satisfies ModelMessage;
        }

        try {
          const output = await executor(tc.input);
          appendEvent(store, {
            type: "tool-result",
            step: steps,
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            output,
            isError: false,
          });
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
        } catch (err) {
          const errorMsg = String(err);
          appendEvent(store, {
            type: "tool-result",
            step: steps,
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            output: errorMsg,
            isError: true,
          });
          // Must return a valid tool-result to keep the LLM message protocol intact
          return {
            role: "tool" as const,
            content: [
              {
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                type: "tool-result" as const,
                output: { type: "text" as const, value: errorMsg },
              },
            ],
          } satisfies ModelMessage;
        }
      }),
    );

    for (const msg of toolResultMessages) {
      messages.push(msg);
    }

    steps++;
  }

  if (steps >= maxSteps) {
    appendEvent(store, { type: "loop-error", step: steps, error: `Max steps (${maxSteps}) reached` });
  }

  return { text: lastText, messages, steps };
}
