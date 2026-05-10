import { useCallback, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { Agent, AgentRunOptions } from "../agents/orchestrator-agent";
import type { AskUserAnswer, AskUserCallback, AskUserRequest, ToolConfirmationCallback, ToolConfirmationRequest } from "../tools/index";
import { TranscriptView } from "./TranscriptView";
import { UserInput } from "./UserInput";

interface AppProps {
  agent: Agent;
}

export interface PendingConfirmation {
  request: ToolConfirmationRequest;
  resolve: (result: "approve" | "deny" | "timeout") => void;
}

export interface PendingAskUser {
  request: AskUserRequest;
  currentIndex: number;
  answers: AskUserAnswer[];
  resolve: (result: { answers: AskUserAnswer[] } | { isError: true; reason: string }) => void;
}

export function shouldSubmit(text: string): boolean {
  return text.trim().length > 0;
}

export function createConfirmationCallback(
  setPending: (pending: PendingConfirmation | null) => void,
): ToolConfirmationCallback {
  return async (request) => {
    return new Promise<"approve" | "deny" | "timeout">((resolve) => {
      setPending({ request, resolve });
    });
  };
}

export function createAskUserCallback(
  setPending: (pending: PendingAskUser | null) => void,
  getPending: () => PendingAskUser | null,
): AskUserCallback {
  return async (request) => {
    const existing = getPending();
    if (existing) {
      return { isError: true, reason: "Another question is already pending" };
    }
    return new Promise<{ answers: AskUserAnswer[] } | { isError: true; reason: string }>((resolve) => {
      setPending({ request, currentIndex: 0, answers: [], resolve });

      if (request.abortSignal) {
        if (request.abortSignal.aborted) {
          resolve({ isError: true, reason: "Cancelled" });
          setPending(null);
          return;
        }
        const onAbort = () => {
          resolve({ isError: true, reason: "Cancelled" });
          setPending(null);
          request.abortSignal!.removeEventListener("abort", onAbort);
        };
        request.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };
}

export function App({ agent }: AppProps) {
  const messages = useStore(agent.store, (s) => s.messages);
  const streamingText = useStore(agent.store, (s) => s.streamingText);
  const streamingReasoning = useStore(agent.store, (s) => s.streamingReasoning);
  const streamingTools = useStore(agent.store, (s) => s.streamingTools);
  const isRunning = useStore(agent.store, (s) => s.isRunning);
  const isStreamingModel = useStore(agent.store, (s) => s.isStreamingModel);
  const reminders = useStore(agent.store, (s) => s.reminders);

  const runningRef = useRef(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingAskUser, setPendingAskUser] = useState<PendingAskUser | null>(null);
  const pendingAskUserRef = useRef<PendingAskUser | null>(null);

  const setPendingAskUserWithRef = useCallback((pending: PendingAskUser | null) => {
    pendingAskUserRef.current = pending;
    setPendingAskUser(pending);
  }, []);

  const confirmPermission = useMemo(
    () => createConfirmationCallback(setPendingConfirmation),
    [setPendingConfirmation],
  );

  const askUser = useMemo(
    () => createAskUserCallback(setPendingAskUserWithRef, () => pendingAskUserRef.current),
    [setPendingAskUserWithRef],
  );

  const handleConfirm = (result: "approve" | "deny") => {
    if (pendingConfirmation) {
      pendingConfirmation.resolve(result);
      setPendingConfirmation(null);
    }
  };

  const handleAskUserAnswer = (answer: string[]) => {
    if (!pendingAskUser) return;
    const { request, currentIndex, answers, resolve } = pendingAskUser;
    const newAnswers = [...answers, answer];
    const nextIndex = currentIndex + 1;

    if (nextIndex >= request.questions.length) {
      resolve({ answers: newAnswers });
      setPendingAskUserWithRef(null);
    } else {
      setPendingAskUserWithRef({ request, currentIndex: nextIndex, answers: newAnswers, resolve });
    }
  };

  const handleAskUserCancel = () => {
    if (pendingAskUser) {
      pendingAskUser.resolve({ isError: true, reason: "Cancelled" });
      setPendingAskUserWithRef(null);
    }
  };

  const handleSubmit = async (text: string) => {
    if (runningRef.current) return;
    if (!shouldSubmit(text)) return;

    runningRef.current = true;

    try {
      await agent.run(text, { confirmPermission, askUser });
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
        reminders={reminders}
      />
      {pendingConfirmation ? (
        <UserInput
          onSubmit={handleSubmit}
          isRunning={isRunning}
          confirmationRequest={pendingConfirmation.request}
          onConfirm={handleConfirm}
        />
      ) : pendingAskUser ? (
        <UserInput
          onSubmit={handleSubmit}
          isRunning={isRunning}
          askUserRequest={pendingAskUser.request}
          askUserCurrentIndex={pendingAskUser.currentIndex}
          onAskUserAnswer={handleAskUserAnswer}
          onAskUserCancel={handleAskUserCancel}
        />
      ) : isRunning && isStreamingModel ? (
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
