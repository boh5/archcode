import { useRef } from "react";
import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { Agent } from "../agents/test-agent";
import { TranscriptView } from "./TranscriptView";
import { UserInput } from "./UserInput";

interface AppProps {
  agent: Agent;
}

export function shouldSubmit(text: string): boolean {
  return text.trim().length > 0;
}

export function App({ agent }: AppProps) {
  const messages = useStore(agent.store, (s) => s.messages);
  const streamingText = useStore(agent.store, (s) => s.streamingText);
  const streamingReasoning = useStore(agent.store, (s) => s.streamingReasoning);
  const streamingTools = useStore(agent.store, (s) => s.streamingTools);
  const isRunning = useStore(agent.store, (s) => s.isRunning);
  const isStreamingModel = useStore(agent.store, (s) => s.isStreamingModel);

  const runningRef = useRef(false);

  const handleSubmit = async (text: string) => {
    if (runningRef.current) return;
    if (!shouldSubmit(text)) return;

    runningRef.current = true;

    try {
      await agent.run(text);
    } catch {
    } finally {
      runningRef.current = false;
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <TranscriptView
        messages={messages}
        streamingText={streamingText}
        streamingReasoning={streamingReasoning}
        streamingTools={streamingTools}
      />
      {isRunning && isStreamingModel ? (
        <Box marginTop={1}>
          <Text color="yellow">⠋ Thinking...</Text>
        </Box>
      ) : isRunning ? (
        <Box marginTop={1}>
          <Text color="yellow">⚙ Executing tools...</Text>
        </Box>
      ) : (
        <UserInput onSubmit={handleSubmit} isRunning={isRunning} />
      )}
    </Box>
  );
}