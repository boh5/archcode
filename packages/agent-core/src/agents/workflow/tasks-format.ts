const TOP_LEVEL_TASK_RE = /^- \[([ x])\] T(\d+)\. (.+)$/;
const NESTED_CHECKBOX_RE = /^\s+- \[[ x]\] (.+)$/;
const FIELD_RE = /^\s{2}([A-Za-z]+):\s*(.*)$/;
const REQUIRED_FIELDS = ["Agent", "Dependencies", "Description", "Acceptance", "QA"] as const;

export type TaskRequiredField = (typeof REQUIRED_FIELDS)[number];

export interface ParsedTaskLines {
  start: number;
  end: number;
  checkbox: number;
  agent?: number;
  dependencies?: number;
  description?: number;
  acceptance?: number;
  qa?: number;
}

export interface ParsedTask {
  id: string;
  title: string;
  checked: boolean;
  agent: string;
  dependencies: string[];
  description: string;
  acceptance: string[];
  qa: string[];
  lines: ParsedTaskLines;
}

export type TasksValidationErrorCode =
  | "INVALID_TASK_HEADING"
  | "DUPLICATE_TASK_ID"
  | "MISSING_FIELD"
  | "INVALID_DEPENDENCIES"
  | "UNKNOWN_DEPENDENCY"
  | "CIRCULAR_DEPENDENCY";

export interface TasksValidationError {
  code: TasksValidationErrorCode;
  message: string;
  line?: number;
  taskId?: string;
  field?: TaskRequiredField;
  dependencyId?: string;
  taskIds?: string[];
}

export interface TasksValidationResult {
  valid: boolean;
  tasks: ParsedTask[];
  errors: TasksValidationError[];
}

interface TaskBlock {
  headingLine: string;
  startLine: number;
  endLine: number;
  headingMatch: RegExpMatchArray | null;
  lines: string[];
}

interface MutableTaskFields {
  agent: string;
  dependenciesRaw: string;
  description: string;
  acceptance: string[];
  qa: string[];
  fieldLines: Partial<Record<Lowercase<TaskRequiredField>, number>>;
}

export function parseTasksMarkdown(content: string): ParsedTask[] {
  return parseTasksMarkdownInternal(content).tasks;
}

export function validateTasksMarkdown(content: string): TasksValidationResult {
  const { tasks, errors } = parseTasksMarkdownInternal(content);
  errors.push(...validateTaskGraph(tasks));

  return {
    valid: errors.length === 0,
    tasks,
    errors,
  };
}

export function calculateReadyWave(tasks: readonly ParsedTask[]): ParsedTask[] {
  const checkedTaskIds = new Set(tasks.filter((task) => task.checked).map((task) => task.id));

  return tasks.filter((task) => {
    if (task.checked) return false;
    return task.dependencies.every((dependencyId) => checkedTaskIds.has(dependencyId));
  });
}

export function toggleTaskCheckbox(content: string, taskId: string, checked: boolean): string {
  const validation = validateTasksMarkdown(content);
  if (!validation.valid || validation.tasks.length === 0) {
    throw new Error("Content is not a valid TASKS.md document");
  }

  const task = validation.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Unknown task id: ${taskId}`);
  }

  const lines = content.split("\n");
  const lineIndex = task.lines.checkbox - 1;
  const line = lines[lineIndex];
  if (!line || !TOP_LEVEL_TASK_RE.test(line)) {
    throw new Error(`Task ${taskId} is not a top-level TASKS.md checkbox`);
  }

  lines[lineIndex] = line.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
  return lines.join("\n");
}

function parseTasksMarkdownInternal(content: string): { tasks: ParsedTask[]; errors: TasksValidationError[] } {
  const blocks = collectTaskBlocks(content);
  const tasks: ParsedTask[] = [];
  const errors: TasksValidationError[] = [];
  const seenTaskIds = new Set<string>();

  for (const block of blocks) {
    if (!block.headingMatch) {
      errors.push({
        code: "INVALID_TASK_HEADING",
        message: `Invalid top-level task checkbox at line ${block.startLine}`,
        line: block.startLine,
      });
    }

    const taskId = block.headingMatch ? `T${block.headingMatch[2]}` : "unknown";
    const title = block.headingMatch?.[3]?.trim() ?? block.headingLine.trim();
    const checked = block.headingMatch?.[1] === "x";

    if (block.headingMatch && seenTaskIds.has(taskId)) {
      errors.push({
        code: "DUPLICATE_TASK_ID",
        message: `Duplicate task id: ${taskId}`,
        line: block.startLine,
        taskId,
      });
    }
    if (block.headingMatch) seenTaskIds.add(taskId);

    const fields = parseTaskFields(block, errors, taskId);
    const dependencies = parseDependencies(fields.dependenciesRaw, block, errors, taskId);

    const task: ParsedTask = {
      id: taskId,
      title,
      checked,
      agent: fields.agent,
      dependencies,
      description: fields.description,
      acceptance: fields.acceptance,
      qa: fields.qa,
      lines: {
        start: block.startLine,
        end: block.endLine,
        checkbox: block.startLine,
        agent: fields.fieldLines.agent,
        dependencies: fields.fieldLines.dependencies,
        description: fields.fieldLines.description,
        acceptance: fields.fieldLines.acceptance,
        qa: fields.fieldLines.qa,
      },
    };
    tasks.push(task);
  }

  return { tasks, errors };
}

function collectTaskBlocks(content: string): TaskBlock[] {
  const lines = content.split("\n");
  const taskStartIndexes: number[] = [];

  lines.forEach((line, index) => {
    if (line.startsWith("- [")) taskStartIndexes.push(index);
  });

  return taskStartIndexes.map((startIndex, index) => {
    const nextStartIndex = taskStartIndexes[index + 1] ?? lines.length;
    const headingLine = lines[startIndex] ?? "";
    return {
      headingLine,
      startLine: startIndex + 1,
      endLine: trimTrailingBlankLines(lines, startIndex, nextStartIndex - 1) + 1,
      headingMatch: headingLine.match(TOP_LEVEL_TASK_RE),
      lines: lines.slice(startIndex, nextStartIndex),
    };
  });
}

function trimTrailingBlankLines(lines: string[], startIndex: number, endIndex: number): number {
  let current = endIndex;
  while (current > startIndex && lines[current]?.trim() === "") current--;
  return current;
}

function parseTaskFields(
  block: TaskBlock,
  errors: TasksValidationError[],
  taskId: string,
): MutableTaskFields {
  const fields: MutableTaskFields = {
    agent: "",
    dependenciesRaw: "",
    description: "",
    acceptance: [],
    qa: [],
    fieldLines: {},
  };
  let currentListField: "acceptance" | "qa" | undefined;

  block.lines.forEach((line, relativeIndex) => {
    if (relativeIndex === 0) return;
    const absoluteLine = block.startLine + relativeIndex;
    const fieldMatch = line.match(FIELD_RE);

    if (fieldMatch) {
      const [, rawName, rawValue = ""] = fieldMatch;
      const name = rawName as TaskRequiredField;
      currentListField = undefined;

      if (name === "Agent") {
        fields.agent = rawValue.trim();
        fields.fieldLines.agent = absoluteLine;
      } else if (name === "Dependencies") {
        fields.dependenciesRaw = rawValue.trim();
        fields.fieldLines.dependencies = absoluteLine;
      } else if (name === "Description") {
        fields.description = rawValue.trim();
        fields.fieldLines.description = absoluteLine;
      } else if (name === "Acceptance") {
        fields.fieldLines.acceptance = absoluteLine;
        currentListField = "acceptance";
      } else if (name === "QA") {
        fields.fieldLines.qa = absoluteLine;
        currentListField = "qa";
      }
      return;
    }

    const checkboxMatch = line.match(NESTED_CHECKBOX_RE);
    if (checkboxMatch && currentListField) {
      fields[currentListField].push(checkboxMatch[1]?.trim() ?? "");
    }
  });

  for (const field of REQUIRED_FIELDS) {
    const key = field.toLowerCase() as Lowercase<TaskRequiredField>;
    const hasScalarValue = field === "Agent" || field === "Dependencies" || field === "Description";
    const isMissing = fields.fieldLines[key] === undefined || (hasScalarValue && getFieldValue(fields, field) === "");
    if (isMissing) {
      errors.push({
        code: "MISSING_FIELD",
        message: `Task ${taskId} is missing required field: ${field}`,
        taskId,
        field,
      });
    }
  }

  return fields;
}

function getFieldValue(fields: MutableTaskFields, field: TaskRequiredField): string {
  if (field === "Agent") return fields.agent;
  if (field === "Dependencies") return fields.dependenciesRaw;
  if (field === "Description") return fields.description;
  return "present";
}

function parseDependencies(
  dependenciesRaw: string,
  block: TaskBlock,
  errors: TasksValidationError[],
  taskId: string,
): string[] {
  if (dependenciesRaw.toLowerCase() === "none") return [];
  if (dependenciesRaw === "") return [];

  const dependencies = dependenciesRaw.split(",").map((dependency) => dependency.trim()).filter(Boolean);
  const invalidDependency = dependencies.find((dependency) => !/^T\d+$/.test(dependency));
  if (invalidDependency) {
    errors.push({
      code: "INVALID_DEPENDENCIES",
      message: `Task ${taskId} has invalid dependency value: ${invalidDependency}`,
      line: block.startLine,
      taskId,
      dependencyId: invalidDependency,
    });
  }

  return dependencies;
}

function validateTaskGraph(tasks: readonly ParsedTask[]): TasksValidationError[] {
  const errors: TasksValidationError[] = [];
  const declaredTaskIds = new Set(tasks.filter((task) => task.id !== "unknown").map((task) => task.id));

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!declaredTaskIds.has(dependencyId)) {
        errors.push({
          code: "UNKNOWN_DEPENDENCY",
          message: `Task ${task.id} depends on undeclared task ${dependencyId}`,
          taskId: task.id,
          dependencyId,
        });
      }
    }
  }

  errors.push(...detectCycles(tasks, declaredTaskIds));
  return errors;
}

function detectCycles(tasks: readonly ParsedTask[], declaredTaskIds: ReadonlySet<string>): TasksValidationError[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const errors: TasksValidationError[] = [];

  const visit = (taskId: string) => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      const cycle = stack.slice(stack.indexOf(taskId));
      const key = [...cycle].sort().join(",");
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        errors.push({
          code: "CIRCULAR_DEPENDENCY",
          message: `Circular dependency detected: ${cycle.join(" -> ")} -> ${taskId}`,
          taskIds: cycle,
        });
      }
      return;
    }

    visiting.add(taskId);
    stack.push(taskId);
    const task = byId.get(taskId);
    for (const dependencyId of task?.dependencies ?? []) {
      if (declaredTaskIds.has(dependencyId)) visit(dependencyId);
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.id);
  return errors;
}
