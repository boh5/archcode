import type { CommandDescriptor, ParsedCommand } from "./types";

export class DuplicateCommandError extends Error {
  constructor(public readonly commandName: string) {
    super(`Duplicate command "${commandName}" is already registered`);
    this.name = "DuplicateCommandError";
  }
}

export class CommandRegistry {
  private readonly descriptors = new Map<string, CommandDescriptor>();

  register(descriptor: CommandDescriptor): void {
    if (this.descriptors.has(descriptor.name)) {
      throw new DuplicateCommandError(descriptor.name);
    }

    this.descriptors.set(descriptor.name, descriptor);
  }

  parse(input: string): ParsedCommand | null {
    if (!input.startsWith("/")) return null;

    const withoutSlash = input.slice(1);
    const trimmedRight = withoutSlash.trimEnd();
    if (trimmedRight.length === 0) return null;

    const match = /^(\S+)(?:\s+(.*))?$/.exec(trimmedRight);
    if (!match?.[1]) return null;

    return {
      command: match[1],
      args: match[2] ?? "",
    };
  }

  get(name: string): CommandDescriptor | undefined {
    return this.descriptors.get(name);
  }
}
