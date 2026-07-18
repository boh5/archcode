import type { StoreApi } from "zustand";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import type { ExecutionModelBinding } from "../models";
import type { SkillService } from "../skills/service";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";

export interface CommandContext {
  store: StoreApi<SessionStoreState>;
  binding: ExecutionModelBinding;
  logger?: Logger;
  circuitBreaker?: CircuitBreaker;
  abort?: AbortSignal;
  cwd: string;
  agentName: string;
  agentSkills: readonly string[];
  skillService: SkillService;
}

export interface SlashCommandResult {
  success: boolean;
  message: string;
  continueAsMessage?: string;
}

export type CommandHandler = (ctx: CommandContext, args?: string) => Promise<SlashCommandResult>;

export interface CommandDescriptor {
  name: string;
  description: string;
  handler: CommandHandler;
}

export interface ParsedCommand {
  command: string;
  args: string;
}
