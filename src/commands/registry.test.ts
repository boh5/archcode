import { describe, expect, mock, test } from "bun:test";
import { CommandRegistry, DuplicateCommandError } from "./registry";
import type { CommandDescriptor } from "./types";

function command(name = "compact"): CommandDescriptor {
  return {
    name,
    description: `${name} command`,
    handler: mock(async () => ({ success: true, message: "ok" })),
  };
}

describe("CommandRegistry", () => {
  test("registers and retrieves a command descriptor", () => {
    const registry = new CommandRegistry();
    const descriptor = command("compact");

    registry.register(descriptor);

    expect(registry.get("compact")).toBe(descriptor);
    expect(registry.get("missing")).toBeUndefined();
  });

  test("throws named duplicate command error", () => {
    const registry = new CommandRegistry();
    registry.register(command("compact"));

    expect(() => registry.register(command("compact"))).toThrow(DuplicateCommandError);
    expect(() => registry.register(command("compact"))).toThrow(
      'Duplicate command "compact" is already registered',
    );
  });

  test("parses exact slash commands and strips trailing whitespace", () => {
    const registry = new CommandRegistry();

    expect(registry.parse("/compact")).toEqual({ command: "compact", args: "" });
    expect(registry.parse("/compact  ")).toEqual({ command: "compact", args: "" });
    expect(registry.parse("/unknown")).toEqual({ command: "unknown", args: "" });
  });

  test("parses arguments after the command name", () => {
    const registry = new CommandRegistry();

    expect(registry.parse("/compact --verbose")).toEqual({
      command: "compact",
      args: "--verbose",
    });
  });

  test("returns null for non slash input and bare slash", () => {
    const registry = new CommandRegistry();

    expect(registry.parse("hello")).toBeNull();
    expect(registry.parse("")).toBeNull();
    expect(registry.parse("/")).toBeNull();
  });
});
