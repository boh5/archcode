import { useRef, useState } from "react";
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
  const events = useStore(agent.store, (s) => s.events);
  const [isRunning, setIsRunning] = useState(false);
  const runningRef = useRef(false);

  const handleSubmit = async (text: string) => {
    if (runningRef.current) return;
    if (!shouldSubmit(text)) return;

    runningRef.current = true;
    setIsRunning(true);

    try {
      await agent.run(text);
    } catch {
      // Agent handles error recording internally (loop-error in store)
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
