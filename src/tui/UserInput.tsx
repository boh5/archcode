import { useReducer } from "react";
import { Box, Text, useInput } from "ink";

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

export function UserInput({ onSubmit, isRunning }: UserInputProps) {
  const [state, dispatch] = useReducer(inputReducer, { text: "" });

  useInput((input, key) => {
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

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan">{">"} {state.text}</Text>
      <Text dimColor>Press Enter to submit</Text>
    </Box>
  );
}
