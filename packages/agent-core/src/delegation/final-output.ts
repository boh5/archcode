import type { SessionExecutionRecord } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";

export const CHILD_FINAL_MISSING_MESSAGE = "[CHILD_FINAL_MISSING] Delegated child completed without a non-blank final answer";
export const CHILD_FINAL_PROTOCOL_ONLY_MESSAGE = "[CHILD_FINAL_PROTOCOL_ONLY] Delegated child final answer contained only tool-control protocol";

export type ChildFinalClassification =
  | { readonly accepted: true; readonly output: string }
  | { readonly accepted: false; readonly error: string };

interface AssistantOutput {
  readonly stepId: string;
  readonly runOrdinal: number;
  readonly text: string;
}

const CONTROL_NAMES = new Set([
  "invoke",
  "tool_call",
  "tool_calls",
  "function_call",
  "function_calls",
  "｜DSML｜invoke",
  "｜DSML｜tool_call",
  "｜DSML｜tool_calls",
  "｜DSML｜function_call",
  "｜DSML｜function_calls",
]);
const PARAMETER_NAME = "parameter";
const DSML_PARAMETER_NAME = "｜DSML｜parameter";
const CONTEXTUAL_DSML_CLOSING_TAIL = /^[^<]*(?:<\/｜DSML｜(?:invoke|tool_call|tool_calls|function_call|function_calls)>\s*)+$/;

/** Locked positive/negative corpus shared by the single production classifier and its tests. */
export const CHILD_FINAL_CLASSIFIER_CORPUS = [
  { label: "blank", final: " \n\t ", expected: "missing" },
  { label: "ascii invoke", final: '<invoke name="search"><parameter name="q">archcode</parameter></invoke>', expected: "protocol-only" },
  { label: "multiple envelopes", final: "<tool_call></tool_call>\n<function_calls><function_call></function_call></function_calls>", expected: "protocol-only" },
  { label: "fullwidth dsml", final: '<｜DSML｜tool_calls><｜DSML｜invoke name="grep"><｜DSML｜parameter name="q">value</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>', expected: "protocol-only" },
  { label: "nested parameter", final: '<｜DSML｜tool_calls><｜DSML｜parameter name="outer">a<｜DSML｜parameter name="inner">b</｜DSML｜parameter>c</｜DSML｜parameter></｜DSML｜tool_calls>', expected: "protocol-only" },
  { label: "fenced protocol", final: "```xml\n<invoke><parameter name=\"q\">value</parameter></invoke>\n```", expected: "protocol-only" },
  { label: "closing tail without evidence", final: "会</｜DSML｜tool_calls>", expected: "accepted" },
  { label: "normal report", final: "Implemented the runtime guard and verified the tests.", expected: "accepted" },
  { label: "ascii inline", final: "The report discusses <invoke> as a protocol tag.", expected: "accepted" },
  { label: "fullwidth inline", final: "The report discusses <｜DSML｜tool_calls> inline.", expected: "accepted" },
  { label: "report with fenced example", final: "Example:\n```xml\n<invoke></invoke>\n```\nThe parser remains bounded.", expected: "accepted" },
] as const;

export const CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS = {
  previous: '<｜DSML｜parameter name="m0007">let me try grep.app search</｜DSML｜parameter>',
  final: "会</｜DSML｜tool_calls>",
} as const;

/** Classifies a proposed delegated-child completion before execution-end is appended. */
export function classifyChildFinalOutput(
  state: Pick<SessionStoreState, "messages">,
  executionId: string,
  finalOutputStepId: string | undefined,
): ChildFinalClassification {
  if (finalOutputStepId === undefined) return { accepted: false, error: CHILD_FINAL_MISSING_MESSAGE };
  const outputs = assistantOutputsForExecution(state, executionId);
  const finalIndex = outputs.findIndex((output) => output.stepId === finalOutputStepId);
  if (finalIndex < 0) return { accepted: false, error: CHILD_FINAL_MISSING_MESSAGE };
  const final = outputs[finalIndex]!;
  if (final.text.trim().length === 0) return { accepted: false, error: CHILD_FINAL_MISSING_MESSAGE };
  if (isControlDocument(final.text)) {
    return { accepted: false, error: CHILD_FINAL_PROTOCOL_ONLY_MESSAGE };
  }
  const previous = outputs[finalIndex - 1];
  if (
    CONTEXTUAL_DSML_CLOSING_TAIL.test(final.text.trim())
    && previous?.runOrdinal === final.runOrdinal
    && (isControlDocument(previous.text) || isDsmlParameterOnlyFragment(previous.text))
  ) {
    return { accepted: false, error: CHILD_FINAL_PROTOCOL_ONLY_MESSAGE };
  }
  return { accepted: true, output: final.text };
}

/**
 * Returns the final assistant text for one completed execution only.
 * No other execution, including an earlier successful run, is eligible.
 */
export function finalOutputForExecution(
  state: Pick<SessionStoreState, "executions" | "messages">,
  executionId: string,
): string | undefined {
  const execution = state.executions.find((candidate) => candidate.id === executionId);
  if (execution?.status !== "completed") return undefined;
  if (execution.finalOutputStepId === undefined) return "";
  const message = state.messages.find((candidate) => (
    candidate.role === "assistant"
    && candidate.executionId === executionId
    && candidate.stepId === execution.finalOutputStepId
    && candidate.outputPhase === "final_answer"
  ));
  return message?.parts
    .filter((part) => part.type === "assistant-output")
    .map((part) => part.text)
    .join("") ?? "";
}

export function latestExecution(
  state: Pick<SessionStoreState, "executions">,
): SessionExecutionRecord | undefined {
  return state.executions.at(-1);
}

function assistantOutputsForExecution(
  state: Pick<SessionStoreState, "messages">,
  executionId: string,
): AssistantOutput[] {
  return state.messages.flatMap((message) => {
    if (message.role !== "assistant" || message.executionId !== executionId) return [];
    const text = message.parts
      .filter((part) => part.type === "assistant-output")
      .map((part) => part.text)
      .join("");
    if (text.length === 0) return [];
    return [{
      stepId: message.stepId,
      runOrdinal: message.runOrdinal,
      text,
    }];
  });
}

function isControlDocument(value: string): boolean {
  return parseControlGrammar(unwrapSingleCodeFence(value), "control");
}

function isDsmlParameterOnlyFragment(value: string): boolean {
  return parseControlGrammar(value, "dsml-parameter");
}

function unwrapSingleCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return match?.[1] ?? value;
}

function parseControlGrammar(value: string, topLevel: "control" | "dsml-parameter"): boolean {
  const stack: Array<{ readonly name: string; readonly kind: "control" | "parameter" }> = [];
  let offset = 0;
  let controlCount = 0;
  let topLevelNodeCount = 0;

  while (offset < value.length) {
    const nextTag = value.indexOf("<", offset);
    const textEnd = nextTag < 0 ? value.length : nextTag;
    const text = value.slice(offset, textEnd);
    if (stack.at(-1)?.kind !== "parameter" && text.trim().length > 0) return false;
    if (nextTag < 0) {
      offset = value.length;
      break;
    }

    const token = /^<\s*(\/?)\s*([^\s/>]+)([^>]*)>/.exec(value.slice(nextTag));
    if (token === null) {
      if (stack.at(-1)?.kind === "parameter") {
        offset = nextTag + 1;
        continue;
      }
      return false;
    }
    const closing = token[1] === "/";
    const name = token[2]!;
    const suffix = token[3] ?? "";
    const selfClosing = !closing && /\/\s*$/.test(suffix);
    const isControl = CONTROL_NAMES.has(name);
    const isParameter = name === PARAMETER_NAME || name === DSML_PARAMETER_NAME;

    if (stack.at(-1)?.kind === "parameter" && !isParameter) {
      offset = nextTag + token[0].length;
      continue;
    }
    if (!isControl && !isParameter) return false;

    if (closing) {
      const open = stack.pop();
      if (open?.name !== name) return false;
    } else {
      if (stack.length === 0) {
        if (topLevel === "control" ? !isControl : name !== DSML_PARAMETER_NAME) return false;
        topLevelNodeCount += 1;
      } else if (stack.at(-1)?.kind === "control" && !isControl && !isParameter) {
        return false;
      }
      if (isControl) controlCount += 1;
      if (!selfClosing) stack.push({ name, kind: isControl ? "control" : "parameter" });
    }
    offset = nextTag + token[0].length;
  }

  return stack.length === 0
    && topLevelNodeCount > 0
    && (topLevel === "control" ? controlCount > 0 : controlCount === 0);
}
