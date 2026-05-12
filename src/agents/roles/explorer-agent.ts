import type { StoreApi } from "zustand";
import type { Registry as ProviderRegistry } from "../../provider/index";
import type { ModelInfo } from "../../provider/model";
import { CommandRegistry, createCompactCommand } from "../../commands/index";
import { buildSystemPrompt, loadAgentsMd } from "../../prompt/index";
import type { PromptContext, PromptEnv } from "../../prompt/index";
import { createSessionStore } from "../../store/store";
import { BusyError } from "../../store/types";
import type { SessionStoreState } from "../../store/types";
import type { AskUserCallback, ToolConfirmationCallback, ToolRegistry } from "../../tools/index";
import { AgentRunningError, NoModelsConfiguredError } from "../errors";
import type { Agent, AgentResult, AgentRunOptions } from "../types";
import { runQueryLoop } from "../query/loop";
import { createAutoInjectReminderHook, createTodoContinuationHook, createAutoCompactHook } from "../query/hooks";
import { getToolsForDepth } from "../tool-filter";
import { EXPLORER_READ_ONLY_TOOLS, DELEGATION_TOOLS } from "../constants";

export { EXPLORER_READ_ONLY_TOOLS, DELEGATION_TOOLS };

export interface ExplorerAgentOptions {
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly askUser?: AskUserCallback;
  readonly workspaceRoot?: string;
  readonly store?: StoreApi<SessionStoreState>;
  readonly depth?: number;
}

function buildEnv(workspaceRoot: string): PromptEnv {
  return {
    platform: process.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    cwd: workspaceRoot,
    date: new Date().toISOString().slice(0, 10),
  };
}

export class ExplorerAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private modelInfo: ModelInfo;
  private confirmPermission: ToolConfirmationCallback | undefined;
  private askUserDefault: AskUserCallback | undefined;
  private workspaceRoot: string;
  private agentsMd: string | undefined;
  private agentsMdLoaded = false;
  private running = false;
  private depth: number;
  private autoCompactHook = createAutoCompactHook();
  private commandRegistry: CommandRegistry;

  constructor(options: ExplorerAgentOptions) {
    this.providerRegistry = options.providerRegistry;
    this.toolRegistry = options.toolRegistry;
    this.confirmPermission = options.confirmPermission;
    this.askUserDefault = options.askUser;

    const modelIds = this.providerRegistry.modelIds;
    if (modelIds.length === 0) {
      throw new NoModelsConfiguredError();
    }

    this.modelInfo = this.providerRegistry.getModel(modelIds[0]);
    this.store = options.store ?? createSessionStore(crypto.randomUUID());
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.depth = options.depth ?? 0;
    this.commandRegistry = new CommandRegistry();
    this.commandRegistry.register(createCompactCommand(this.store, this.modelInfo, this.autoCompactHook.circuitBreaker));
  }

  private async ensureAgentsMd(): Promise<void> {
    if (this.agentsMdLoaded) return;
    this.agentsMd = (await loadAgentsMd(this.workspaceRoot)) ?? undefined;
    this.agentsMdLoaded = true;
  }

  async run(
    userMessage: string,
    abortOrOptions?: AbortSignal | AgentRunOptions,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult> {
    let abort: AbortSignal | undefined;
    let confirm: ToolConfirmationCallback | undefined;
    let askUser: AskUserCallback | undefined;

    if (abortOrOptions && typeof abortOrOptions === "object" && abortOrOptions instanceof AbortSignal) {
      abort = abortOrOptions;
      confirm = confirmPermission ?? this.confirmPermission;
      askUser = this.askUserDefault;
    } else if (abortOrOptions && typeof abortOrOptions === "object") {
      const opts = abortOrOptions as AgentRunOptions;
      abort = opts.abort;
      confirm = opts.confirmPermission ?? this.confirmPermission;
      askUser = opts.askUser ?? this.askUserDefault;
    } else {
      abort = undefined;
      confirm = confirmPermission ?? this.confirmPermission;
      askUser = this.askUserDefault;
    }

    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    try {
      await this.ensureAgentsMd();
      const allowedTools = getToolsForDepth(this.depth, "explore", this.toolRegistry.getAll()).map(
        (tool) => tool.name,
      );

      const ctx: PromptContext = {
        allowedTools,
        workspaceRoot: this.workspaceRoot,
        agentId: "explorer",
        agentsMd: this.agentsMd,
        env: buildEnv(this.workspaceRoot),
      };

      const systemPrompt = await buildSystemPrompt(ctx);

      const result = await runQueryLoop(
        {
          modelInfo: this.modelInfo,
          toolRegistry: this.toolRegistry,
          allowedTools,
          workspaceRoot: this.workspaceRoot,
          confirmPermission: confirm,
          askUser,
          abort,
          systemPrompt,
          store: this.store,
          commandRegistry: this.commandRegistry,
          currentDepth: this.depth,
          hooks: {
            beforeModelBuild: [this.autoCompactHook.hook],
            beforeModelCall: [createAutoInjectReminderHook()],
            afterStepEnd: [createTodoContinuationHook()],
          },
        },
        userMessage,
      );
      return { text: result.text, steps: result.steps };
    } catch (error) {
      if (!(error instanceof BusyError)) {
        this.store.getState().append({
          type: "loop-error",
          step: -1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}