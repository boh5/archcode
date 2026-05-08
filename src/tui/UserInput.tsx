import { useReducer } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserQuestion, AskUserRequest, ToolConfirmationRequest } from "../tools/index";

export interface InputState {
  text: string;
}

export type InputAction =
  | { type: "type"; char: string }
  | { type: "backspace" }
  | { type: "submit" }
  | { type: "paste"; text: string };

export interface UserInputProps {
  onSubmit: (text: string) => void | Promise<void>;
  isRunning: boolean;
  confirmationRequest?: ToolConfirmationRequest | null;
  onConfirm?: (result: "approve" | "deny") => void;
  askUserRequest?: AskUserRequest | null;
  askUserCurrentIndex?: number;
  onAskUserAnswer?: (answer: string[]) => void;
  onAskUserCancel?: () => void;
}

export function handleConfirmationInput(
  input: string,
  key: { escape?: boolean; ctrlC?: boolean },
): "approve" | "deny" | null {
  if (key.escape) return "deny";
  if (key.ctrlC) return "deny";
  if (input === "y" || input === "Y") return "approve";
  if (input === "n" || input === "N") return "deny";
  return null;
}

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case "type":
      return { text: state.text + action.char };
    case "backspace":
      return { text: state.text.slice(0, -1) };
    case "submit":
      return { text: "" };
    case "paste":
      return { text: state.text + action.text };
  }
}

export function parseAnswer(input: string, question: AskUserQuestion): string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];

  const options = question.options;

  if (!question.multiple) {
    // Single choice: only accept a single number
    if (/^\d+$/.test(trimmed)) {
      const index = parseInt(trimmed, 10) - 1;
      if (index >= 0 && index < options.length) {
        return [options[index].label];
      }
    }
    // Free text (only allowed when custom is enabled)
    if (question.custom !== false) {
      return [trimmed];
    }
    return [];
  }

  // Multiple choice: accept comma-separated numbers
  if (/^\d+(?:,\d+)*$/.test(trimmed)) {
    const indices = trimmed.split(",").map((s) => parseInt(s, 10) - 1);
    const selected = indices
      .filter((i) => i >= 0 && i < options.length)
      .map((i) => options[i].label);
    if (selected.length > 0) return selected;
  }

  // Custom text (comma-separated for multiple)
  if (question.custom !== false) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return parts.length > 0 ? parts : [trimmed];
  }

  return [];
}

export function UserInput({ onSubmit, isRunning, confirmationRequest, onConfirm, askUserRequest, askUserCurrentIndex, onAskUserAnswer, onAskUserCancel }: UserInputProps) {
  const [state, dispatch] = useReducer(inputReducer, { text: "" });

  useInput((input, key) => {
    if (confirmationRequest) {
      const result = handleConfirmationInput(input, key);
      if (result && onConfirm) {
        onConfirm(result);
      }
      return;
    }

    if (askUserRequest) {
      const currentQuestion = askUserRequest.questions[askUserCurrentIndex ?? 0];

      if (key.escape) {
        onAskUserCancel?.();
        return;
      }
      if (key.return) {
        if (state.text.trim().length > 0) {
          const answer = parseAnswer(state.text.trim(), currentQuestion);
          onAskUserAnswer?.(answer);
          dispatch({ type: "submit" });
        }
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "backspace" });
      } else if (input) {
        if (input.includes("\n") || input.includes("\r")) {
          dispatch({ type: "paste", text: input });
        } else {
          dispatch({ type: "type", char: input });
        }
      }
      return;
    }

    if (isRunning) return;

    if (key.return) {
      if (state.text.trim().length > 0) {
        onSubmit(state.text);
        dispatch({ type: "submit" });
      }
      return;
    }

    if (key.backspace || key.delete) {
      dispatch({ type: "backspace" });
    } else if (input) {
      if (input.includes("\n") || input.includes("\r")) {
        dispatch({ type: "paste", text: input });
      } else {
        dispatch({ type: "type", char: input });
      }
    }
  });

  if (confirmationRequest) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">{confirmationRequest.reason ?? confirmationRequest.description}</Text>
        <Text dimColor>Allow? [y/n]</Text>
      </Box>
    );
  }

  if (askUserRequest) {
    const idx = askUserCurrentIndex ?? 0;
    const currentQuestion = askUserRequest.questions[idx];
    const total = askUserRequest.questions.length;
    const options = currentQuestion.options ?? [];
    const customEnabled = currentQuestion.custom !== false;

    return (
      <Box marginTop={1} flexDirection="column">
        {total > 1 && (
          <Text color="cyan">[{idx + 1}/{total}]</Text>
        )}
        {currentQuestion.header && <Text bold color="cyan">{currentQuestion.header}</Text>}
        <Text color="cyan">{currentQuestion.question}</Text>
        {options.map((opt, i) => (
          <Text key={i} color="gray">  {i + 1}. {opt.label}{opt.description ? ` — ${opt.description}` : ""}</Text>
        ))}
        <Text color="cyan">{">"} {state.text}</Text>
        {customEnabled ? (
          <Text dimColor>Enter number or type answer{currentQuestion.multiple ? " (comma-separate for multiple)" : ""}. Esc to cancel</Text>
        ) : (
          <Text dimColor>Enter number to select{currentQuestion.multiple ? " (comma-separate for multiple)" : ""}. Esc to cancel</Text>
        )}
      </Box>
    );
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan">{">"} {state.text}</Text>
      <Text dimColor>Press Enter to submit</Text>
    </Box>
  );
}
