import {
  calculateReadyWave,
  parseTasksMarkdown,
  toggleTaskCheckbox,
  validateTasksMarkdown,
  type ParsedTask,
} from "./tasks-format";

export interface ForemanWaveTodo {
  content: string;
  taskIds: string[];
}

export interface ForemanDelegation {
  taskId: string;
  target: "builder" | "reviewer";
  task: ParsedTask;
}

export interface ForemanWaveStep {
  waveNumber: number;
  sourceRead: string;
  todo: ForemanWaveTodo;
  delegations: ForemanDelegation[];
  rereadAfterChecks: boolean;
}

export interface ForemanWaveExecutionResult {
  steps: ForemanWaveStep[];
  finalTasksMarkdown: string;
}

export type ReadyWaveSelector = typeof calculateReadyWave;

export interface SimulateForemanWaveExecutionOptions {
  selectReadyWave?: ReadyWaveSelector;
}

export class ForemanTasksFormatError extends Error {
  constructor(public readonly messages: readonly string[]) {
    super(`Invalid TASKS.md: ${messages.join("; ")}`);
    this.name = "ForemanTasksFormatError";
  }
}

export function createForemanWaveTodo(waveNumber: number, tasks: readonly ParsedTask[]): ForemanWaveTodo {
  const taskIds = tasks.map((task) => task.id);
  return {
    content: `Wave ${waveNumber}: ${taskIds.join(", ")}`,
    taskIds,
  };
}

export function planForemanReadyWave(
  tasksMarkdown: string,
  waveNumber: number,
  selectReadyWave: ReadyWaveSelector = calculateReadyWave,
): ForemanWaveStep | null {
  const validation = validateTasksMarkdown(tasksMarkdown);
  if (!validation.valid) {
    throw new ForemanTasksFormatError(validation.errors.map((error) => error.message));
  }

  const tasks = parseTasksMarkdown(tasksMarkdown);
  const readyTasks = selectReadyWave(tasks);
  if (readyTasks.length === 0) return null;

  return {
    waveNumber,
    sourceRead: tasksMarkdown,
    todo: createForemanWaveTodo(waveNumber, readyTasks),
    delegations: readyTasks.map((task) => ({
      taskId: task.id,
      target: task.agent.toLowerCase() === "reviewer" ? "reviewer" : "builder",
      task,
    })),
    rereadAfterChecks: false,
  };
}

export function simulateForemanWaveExecution(
  initialTasksMarkdown: string,
  options: SimulateForemanWaveExecutionOptions = {},
): ForemanWaveExecutionResult {
  const steps: ForemanWaveStep[] = [];
  let tasksMarkdown = initialTasksMarkdown;
  let waveNumber = 1;

  while (true) {
    const step = planForemanReadyWave(tasksMarkdown, waveNumber, options.selectReadyWave);
    if (!step) break;

    for (const delegation of step.delegations) {
      tasksMarkdown = toggleTaskCheckbox(tasksMarkdown, delegation.taskId, true);
    }
    step.rereadAfterChecks = true;
    steps.push(step);
    waveNumber += 1;
  }

  return {
    steps,
    finalTasksMarkdown: tasksMarkdown,
  };
}
