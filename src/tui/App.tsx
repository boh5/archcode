import { useRef, useState } from "react";
import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool } from "ai";
import { randomUUID } from "node:crypto";
import { runQueryLoop } from "../agents/query/loop";
import type { ToolExecutorMap } from "../agents/query/types";
import type { SessionTranscriptState } from "../store/types";
import { TranscriptView } from "./TranscriptView";
import { UserInput } from "./UserInput";

interface AppProps {
  store: StoreApi<SessionTranscriptState>;
  model: LanguageModelV3;
  tools: Record<string, Tool>;
  toolExecutors: ToolExecutorMap;
  systemPrompt?: string;
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function shouldSubmit(text: string): boolean {
  return text.trim().length > 0;
}

export function App({
  store,
  model,
  tools,
  toolExecutors,
  systemPrompt,
}: AppProps) {
  const events = useStore(store, (s) => s.events);
  const [isRunning, setIsRunning] = useState(false);
  const runningRef = useRef(false);

  const handleSubmit = async (text: string) => {
    if (runningRef.current) return;
    if (!shouldSubmit(text)) return;

    runningRef.current = true;
    setIsRunning(true);

    try {
      await runQueryLoop({ model, tools, toolExecutors, systemPrompt, store }, text);
    } catch (err) {
      store.getState().append({
        type: "loop-error",
        id: randomUUID(),
        timestamp: Date.now(),
        step: -1,
        error: normalizeError(err),
      });
    } finally {
      runningRef.current = false;
      setIsRunning(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <TranscriptView events={events} />
      {isRunning ? (
        <Box marginTop={1}>
          <Text color="yellow">⠋ Thinking...</Text>
        </Box>
      ) : (
        <UserInput onSubmit={handleSubmit} isRunning={isRunning} />
      )}
    </Box>
  );
}
