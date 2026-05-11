import type { StoreApi } from "zustand";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import type { ModelInfo } from "../provider/model";
import type { SessionStoreState } from "../store/types";

export interface CommandContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  circuitBreaker?: CircuitBreaker;
  abort?: AbortSignal;
}

export interface CommandResult {
  success: boolean;
  message: string;
}

export type CommandHandler = (ctx: CommandContext, args?: string) => Promise<CommandResult>;

export interface CommandDescriptor {
  name: string;
  description: string;
  handler: CommandHandler;
}

export interface ParsedCommand {
  command: string;
  args: string;
}
