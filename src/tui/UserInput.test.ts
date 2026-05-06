import { describe, expect, test } from "bun:test";
import { inputReducer } from "./UserInput";
import type { InputAction, InputState } from "./UserInput";

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
