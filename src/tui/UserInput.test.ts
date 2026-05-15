import { describe, expect, test } from "bun:test";
import { inputReducer, handleConfirmationInput, parseAnswer } from "./UserInput";
import type { InputAction, InputState } from "./UserInput";
import type { AskUserQuestion, ToolConfirmationRequest } from "../tools/types";

const eligibleRequest: ToolConfirmationRequest = {
  toolName: "bash",
  toolCallId: "tc-1",
  input: { command: "rm -rf /tmp/test" },
  description: "Run destructive shell command",
  reason: "Destructive bash command",
  approval: { eligible: true, display: "bash: rm -rf /tmp/test", reason: "Destructive command" },
};

const ineligibleRequest: ToolConfirmationRequest = {
  toolName: "bash",
  toolCallId: "tc-2",
  input: { command: "ls" },
  description: "Run shell command",
  reason: "Shell command",
  approval: { eligible: false, display: "bash: ls", reason: "Parser uncertainty" },
};

const noApprovalRequest: ToolConfirmationRequest = {
  toolName: "bash",
  toolCallId: "tc-3",
  input: { command: "cat /etc/hosts" },
  description: "Run shell command",
  reason: "Shell command",
};

describe("handleConfirmationInput", () => {
  test("1 resolves approve_once", () => {
    expect(handleConfirmationInput("1", { escape: false }, eligibleRequest)).toBe("approve_once");
  });

  test("o resolves approve_once", () => {
    expect(handleConfirmationInput("o", { escape: false }, eligibleRequest)).toBe("approve_once");
  });

  test("y resolves approve_once (backward compat)", () => {
    expect(handleConfirmationInput("y", { escape: false }, eligibleRequest)).toBe("approve_once");
  });

  test("Y resolves approve_once (backward compat)", () => {
    expect(handleConfirmationInput("Y", { escape: false }, eligibleRequest)).toBe("approve_once");
  });

  test("2 resolves approve_always when eligible", () => {
    expect(handleConfirmationInput("2", { escape: false }, eligibleRequest)).toBe("approve_always");
  });

  test("a resolves approve_always when eligible", () => {
    expect(handleConfirmationInput("a", { escape: false }, eligibleRequest)).toBe("approve_always");
  });

  test("2 denies when ineligible", () => {
    expect(handleConfirmationInput("2", { escape: false }, ineligibleRequest)).toBe("deny");
  });

  test("a denies when ineligible", () => {
    expect(handleConfirmationInput("a", { escape: false }, ineligibleRequest)).toBe("deny");
  });

  test("2 denies when no approval", () => {
    expect(handleConfirmationInput("2", { escape: false }, noApprovalRequest)).toBe("deny");
  });

  test("a denies when no approval", () => {
    expect(handleConfirmationInput("a", { escape: false }, noApprovalRequest)).toBe("deny");
  });

  test("3 resolves deny", () => {
    expect(handleConfirmationInput("3", { escape: false }, eligibleRequest)).toBe("deny");
  });

  test("d resolves deny", () => {
    expect(handleConfirmationInput("d", { escape: false }, eligibleRequest)).toBe("deny");
  });

  test("n resolves deny (backward compat)", () => {
    expect(handleConfirmationInput("n", { escape: false }, eligibleRequest)).toBe("deny");
  });

  test("N resolves deny (backward compat)", () => {
    expect(handleConfirmationInput("N", { escape: false }, eligibleRequest)).toBe("deny");
  });

  test("Escape resolves deny", () => {
    expect(handleConfirmationInput("", { escape: true }, eligibleRequest)).toBe("deny");
  });

  test("Ctrl+C resolves deny", () => {
    expect(handleConfirmationInput("", { ctrlC: true }, eligibleRequest)).toBe("deny");
  });

  test("ctrlC takes priority over input", () => {
    expect(handleConfirmationInput("y", { ctrlC: true }, eligibleRequest)).toBe("deny");
  });

  test("escape takes priority over input", () => {
    expect(handleConfirmationInput("y", { escape: true }, eligibleRequest)).toBe("deny");
  });

  test("other input returns null (ignored)", () => {
    expect(handleConfirmationInput("x", { escape: false }, eligibleRequest)).toBeNull();
    expect(handleConfirmationInput(" ", { escape: false }, eligibleRequest)).toBeNull();
  });

  test("1 and o work without confirmationRequest (no approval context)", () => {
    expect(handleConfirmationInput("1", { escape: false })).toBe("approve_once");
    expect(handleConfirmationInput("o", { escape: false })).toBe("approve_once");
  });

  test("y and Y work without confirmationRequest (backward compat)", () => {
    expect(handleConfirmationInput("y", { escape: false })).toBe("approve_once");
    expect(handleConfirmationInput("Y", { escape: false })).toBe("approve_once");
  });

  test("3 and d work without confirmationRequest", () => {
    expect(handleConfirmationInput("3", { escape: false })).toBe("deny");
    expect(handleConfirmationInput("d", { escape: false })).toBe("deny");
  });

  test("2 and a deny without confirmationRequest", () => {
    expect(handleConfirmationInput("2", { escape: false })).toBe("deny");
    expect(handleConfirmationInput("a", { escape: false })).toBe("deny");
  });
});

describe("inputReducer", () => {
  test("supports the initial empty state shape", () => {
    const initialState: InputState = { text: "" };

    expect(initialState).toEqual({ text: "" });
  });

  test("adds typed characters", () => {
    expect(inputReducer({ text: "" }, { type: "type", char: "a" })).toEqual({ text: "a" });
    expect(inputReducer({ text: "a" }, { type: "type", char: "b" })).toEqual({ text: "ab" });
    expect(inputReducer({ text: "a" }, { type: "type", char: " b" })).toEqual({ text: "a b" });
  });

  test("removes the last character on backspace", () => {
    expect(inputReducer({ text: "" }, { type: "backspace" })).toEqual({ text: "" });
    expect(inputReducer({ text: "ab" }, { type: "backspace" })).toEqual({ text: "a" });
    expect(inputReducer({ text: "a" }, { type: "backspace" })).toEqual({ text: "" });
  });

  test("clears text on submit", () => {
    expect(inputReducer({ text: "anything" }, { type: "submit" })).toEqual({ text: "" });
    expect(inputReducer({ text: "multi character text" }, { type: "submit" })).toEqual({ text: "" });
  });

  test("appends pasted text with newlines preserved", () => {
    expect(inputReducer({ text: "" }, { type: "paste", text: "hello\nworld" })).toEqual({ text: "hello\nworld" });
    expect(inputReducer({ text: "say: " }, { type: "paste", text: "hello\nworld" })).toEqual({ text: "say: hello\nworld" });
  });

  test("handles type type backspace sequence", () => {
    const actions: InputAction[] = [
      { type: "type", char: "a" },
      { type: "type", char: "b" },
      { type: "backspace" },
    ];

    const state = actions.reduce(inputReducer, { text: "" });

    expect(state).toEqual({ text: "a" });
  });

  test("handles typing hello, submitting, then typing world", () => {
    let state: InputState = { text: "" };

    for (const char of "hello") {
      state = inputReducer(state, { type: "type", char });
    }
    expect(state).toEqual({ text: "hello" });

    state = inputReducer(state, { type: "submit" });
    expect(state).toEqual({ text: "" });

    for (const char of "world") {
      state = inputReducer(state, { type: "type", char });
    }
    expect(state).toEqual({ text: "world" });
  });
});

describe("parseAnswer", () => {
  const singleChoiceQuestion: AskUserQuestion = {
    question: "Which file?",
    header: "File",
    options: [
      { label: "src/main.ts", description: "Main entry point" },
      { label: "src/utils.ts", description: "Utility functions" },
    ],
    custom: true,
  };

  const multiChoiceQuestion: AskUserQuestion = {
    question: "What features?",
    header: "Features",
    multiple: true,
    options: [
      { label: "Dark mode", description: "Dark color scheme" },
      { label: "Compact", description: "Compact layout" },
      { label: "Animations", description: "Smooth transitions" },
    ],
    custom: true,
  };

  const noOptionsQuestion: AskUserQuestion = {
    question: "What is your name?",
    header: "Name",
    options: [],
    custom: true,
  };

  const noCustomQuestion: AskUserQuestion = {
    question: "Pick one",
    header: "Choice",
    custom: false,
    options: [
      { label: "Option A", description: "First option" },
      { label: "Option B", description: "Second option" },
    ],
  };

  const noCustomMultiQuestion: AskUserQuestion = {
    question: "Pick multiple",
    header: "Choices",
    custom: false,
    multiple: true,
    options: [
      { label: "Red", description: "Color red" },
      { label: "Blue", description: "Color blue" },
      { label: "Green", description: "Color green" },
    ],
  };

  // Single choice tests
  test("selects option by number for single choice", () => {
    const result = parseAnswer("1", singleChoiceQuestion);
    expect(result).toEqual(["src/main.ts"]);
  });

  test("selects second option by number", () => {
    const result = parseAnswer("2", singleChoiceQuestion);
    expect(result).toEqual(["src/utils.ts"]);
  });

  test("returns free text when input is not a number", () => {
    const result = parseAnswer("my-custom-file.ts", singleChoiceQuestion);
    expect(result).toEqual(["my-custom-file.ts"]);
  });

  // Bug fix: single-choice should NOT parse "1,2" as multi-select
  test("returns free text for comma-separated numbers in single-choice", () => {
    const result = parseAnswer("1,2", singleChoiceQuestion);
    expect(result).toEqual(["1,2"]);
  });

  // Multi choice tests
  test("selects multiple options by comma-separated numbers for multi-choice", () => {
    const result = parseAnswer("1,3", multiChoiceQuestion);
    expect(result).toEqual(["Dark mode", "Animations"]);
  });

  test("selects all options by comma-separated numbers", () => {
    const result = parseAnswer("1,2,3", multiChoiceQuestion);
    expect(result).toEqual(["Dark mode", "Compact", "Animations"]);
  });

  test("falls back to free text for non-multiple question when number is out of range", () => {
    const result = parseAnswer("99", singleChoiceQuestion);
    expect(result).toEqual(["99"]);
  });

  test("falls back to comma-separated text for multiple question when not all numbers", () => {
    const result = parseAnswer("hello, world", multiChoiceQuestion);
    expect(result).toEqual(["hello", "world"]);
  });

  test("handles single text input for multiple question", () => {
    const result = parseAnswer("custom answer", multiChoiceQuestion);
    expect(result).toEqual(["custom answer"]);
  });

  test("selects single option by number for multiple question", () => {
    const result = parseAnswer("2", multiChoiceQuestion);
    expect(result).toEqual(["Compact"]);
  });

  // No-options question (custom only)
  test("returns free text for no-options question", () => {
    const result = parseAnswer("Alice", noOptionsQuestion);
    expect(result).toEqual(["Alice"]);
  });

  // custom: false tests
  test("selects option by number when custom is false", () => {
    const result = parseAnswer("1", noCustomQuestion);
    expect(result).toEqual(["Option A"]);
  });

  test("returns empty array for invalid number when custom is false", () => {
    const result = parseAnswer("99", noCustomQuestion);
    expect(result).toEqual([]);
  });

  test("returns empty array for free text when custom is false (single)", () => {
    const result = parseAnswer("hello", noCustomQuestion);
    expect(result).toEqual([]);
  });

  test("returns empty array for comma-separated numbers in single-choice when custom is false", () => {
    const result = parseAnswer("1,2", noCustomQuestion);
    expect(result).toEqual([]);
  });

  test("selects multiple by comma-separated numbers when custom is false (multi)", () => {
    const result = parseAnswer("1,3", noCustomMultiQuestion);
    expect(result).toEqual(["Red", "Green"]);
  });

  test("returns empty array for free text when custom is false (multi)", () => {
    const result = parseAnswer("red, blue", noCustomMultiQuestion);
    expect(result).toEqual([]);
  });

  // Edge cases
  test("returns empty array for empty input", () => {
    const result = parseAnswer("", singleChoiceQuestion);
    expect(result).toEqual([]);
  });

  test("returns empty array for whitespace-only input", () => {
    const result = parseAnswer("   ", singleChoiceQuestion);
    expect(result).toEqual([]);
  });

  test("trims whitespace from input before parsing number", () => {
    const result = parseAnswer("  1  ", singleChoiceQuestion);
    expect(result).toEqual(["src/main.ts"]);
  });

  test("handles spaces around commas in multi-select", () => {
    const result = parseAnswer("1, 3", multiChoiceQuestion);
    // "1, 3" does not match /^\d+(?:,\d+)*$/ because of space after comma
    // so it falls back to comma-separated text
    expect(result).toEqual(["1", "3"]);
  });
});
