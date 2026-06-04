import { generateText, streamText } from "ai";

export interface LlmAdapter {
  readonly streamText: typeof streamText;
  readonly generateText: typeof generateText;
}

const defaultAdapter: LlmAdapter = { streamText, generateText };
let currentAdapter: LlmAdapter = defaultAdapter;

export function getLlmAdapter(): LlmAdapter {
  return currentAdapter;
}

export function setLlmAdapterForTest(adapter: Partial<LlmAdapter> | undefined): void {
  currentAdapter = adapter ? { ...defaultAdapter, ...adapter } : defaultAdapter;
}
