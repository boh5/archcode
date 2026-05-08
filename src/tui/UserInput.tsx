import { useReducer } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserRequest, ToolConfirmationRequest } from "../tools/index";

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
  onAskUserAnswer?: (answer: string) => void;
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

export function UserInput({ onSubmit, isRunning, confirmationRequest, onConfirm, askUserRequest, onAskUserAnswer, onAskUserCancel }: UserInputProps) {
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
      if (key.escape) {
        onAskUserCancel?.();
        return;
      }
      if (key.return) {
        if (state.text.trim().length > 0) {
          onAskUserAnswer?.(state.text.trim());
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
        <Text color="yellow">{confirmationRequest.description}</Text>
        <Text dimColor>Allow? [y/n]</Text>
      </Box>
    );
  }

  if (askUserRequest) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">{askUserRequest.question}</Text>
        <Text color="cyan">{">"} {state.text}</Text>
        <Text dimColor>Press Enter to submit, Escape to cancel</Text>
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
