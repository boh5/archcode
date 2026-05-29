import {
  getToolCategory,
  isBuiltinToolName,
  type BuiltinToolName,
  type ToolCategory,
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_BASH,
  TOOL_DELEGATE,
  TOOL_WEB_FETCH,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_SYMBOLS,
  TOOL_GIT_STATUS,
  TOOL_GIT_DIFF,
  TOOL_TODO_WRITE,
  TOOL_ASK_USER,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_READ,
  TOOL_WORKFLOW_UPDATE_STAGE,
  TOOL_WORKFLOW_TASK_CHECK,
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
  TOOL_AST_GREP_SEARCH,
  TOOL_AST_GREP_REPLACE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
} from "@specra/protocol";
import type { ToolDiffMetadata } from "@specra/protocol";

// ─── Threshold constants ───

export const INLINE_VALUE_MAX_CHARS = 160;
export const INLINE_VALUE_MAX_LINES = 4;
export const CONTENT_SUMMARY_THRESHOLD_CHARS = 200;
export const CONTENT_SUMMARY_THRESHOLD_LINES = 8;

// ─── Tool icon map ───

const CATEGORY_ICONS: Record<ToolCategory, string> = {
  fileRead: "📄",
  fileWrite: "✏️",
  search: "🔍",
  git: "🔀",
  shell: "💻",
  interaction: "💬",
  lsp: "🔧",
  web: "🌐",
  delegation: "🤝",
  skill: "⚡",
  memory: "🧠",
  workflow: "📋",
  mcp: "🔌",
  other: "❓",
};

export function getToolIcon(category: ToolCategory): string {
  return CATEGORY_ICONS[category] ?? "❓";
}

// ─── Tool summary model ───

export interface ToolSummary {
  icon: string;
  verb: string;
  primary: string;
  secondary?: string;
}

const BUILTIN_VERBS: Partial<Record<BuiltinToolName, string>> = {
  [TOOL_FILE_READ]: "Read",
  [TOOL_FILE_WRITE]: "Write",
  [TOOL_FILE_EDIT]: "Edit",
  [TOOL_GREP]: "Search",
  [TOOL_GLOB]: "Find",
  [TOOL_AST_GREP_SEARCH]: "AST Search",
  [TOOL_AST_GREP_REPLACE]: "AST Replace",
  [TOOL_BASH]: "Run",
  [TOOL_GIT_STATUS]: "Status",
  [TOOL_GIT_DIFF]: "Diff",
  [TOOL_WEB_FETCH]: "Fetch",
  [TOOL_LSP_DIAGNOSTICS]: "Diagnose",
  [TOOL_LSP_GOTO_DEFINITION]: "Go to Def",
  [TOOL_LSP_FIND_REFERENCES]: "Find Refs",
  [TOOL_LSP_SYMBOLS]: "Symbols",
  [TOOL_DELEGATE]: "Delegate",
  [TOOL_WAIT_FOR_REMINDER]: "Wait",
  [TOOL_BACKGROUND_OUTPUT]: "Background",
  [TOOL_VIEW_TOOL_OUTPUT]: "View Output",
  [TOOL_TODO_WRITE]: "Todo",
  [TOOL_ASK_USER]: "Ask",
  [TOOL_MEMORY_READ]: "Memory Read",
  [TOOL_MEMORY_WRITE]: "Memory Write",
  [TOOL_WORKFLOW_CREATE]: "Create Workflow",
  [TOOL_WORKFLOW_READ]: "Read Workflow",
  [TOOL_WORKFLOW_UPDATE_STAGE]: "Update Stage",
  [TOOL_WORKFLOW_TASK_CHECK]: "Task Check",
  [TOOL_ARTIFACT_READ]: "Read Artifact",
  [TOOL_ARTIFACT_WRITE]: "Write Artifact",
  [TOOL_SKILL_LIST]: "List Skills",
  [TOOL_SKILL_READ]: "Read Skill",
};

function extractPath(input: Record<string, unknown>): string | undefined {
  return (
    (typeof input.filePath === "string" ? input.filePath : undefined) ??
    (typeof input.file_path === "string" ? input.file_path : undefined) ??
    (typeof input.path === "string" ? input.path : undefined)
  );
}

function summarizeContent(value: string): string {
  const lines = value.split("\n");
  const charCount = value.length;
  const lineCount = lines.length;
  return `${charCount} chars, ${lineCount} lines`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "…";
}

function firstMeaningfulString(input: Record<string, unknown>): string | undefined {
  const priorityKeys = ["query", "prompt", "url", "path"];
  for (const key of priorityKeys) {
    const val = input[key];
    if (typeof val === "string" && val.trim()) return truncate(val, INLINE_VALUE_MAX_CHARS);
  }
  for (const [, val] of Object.entries(input)) {
    if (typeof val === "string" && val.trim()) return truncate(val, INLINE_VALUE_MAX_CHARS);
  }
  return undefined;
}

export function getToolSummary(toolName: string, input: unknown): ToolSummary {
  const category = getToolCategory(toolName);
  const icon = getToolIcon(category);

  if (input === null || input === undefined) {
    return { icon, verb: BUILTIN_VERBS[toolName as BuiltinToolName] ?? toolName, primary: "—" };
  }

  if (typeof input === "string") {
    return { icon, verb: BUILTIN_VERBS[toolName as BuiltinToolName] ?? toolName, primary: truncate(input, INLINE_VALUE_MAX_CHARS) };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return { icon, verb: BUILTIN_VERBS[toolName as BuiltinToolName] ?? toolName, primary: String(input) };
  }

  const obj = input as Record<string, unknown>;

  // MCP tools: server/tool · primary value
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.slice(5).split("__");
    const serverTool = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join("__")}` : toolName;
    const primary = firstMeaningfulString(obj) ?? serverTool;
    return { icon, verb: serverTool, primary };
  }

  // Bash: two-part model (description + command)
  if (toolName === TOOL_BASH) {
    const description = typeof obj.description === "string" ? obj.description : undefined;
    const command = typeof obj.command === "string" ? obj.command : undefined;
    return {
      icon,
      verb: "Run",
      primary: description ?? command ?? "—",
      secondary: description && command ? truncate(command, INLINE_VALUE_MAX_CHARS) : undefined,
    };
  }

  // File tools: path
  if (toolName === TOOL_FILE_READ || toolName === TOOL_FILE_WRITE || toolName === TOOL_FILE_EDIT) {
    const path = extractPath(obj);
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "File";
    if (toolName === TOOL_FILE_WRITE && typeof obj.content === "string") {
      return { icon, verb, primary: path ?? "—", secondary: summarizeContent(obj.content) };
    }
    return { icon, verb, primary: path ?? "—" };
  }

  // Search tools: pattern
  if (toolName === TOOL_GREP || toolName === TOOL_GLOB || toolName === TOOL_AST_GREP_SEARCH) {
    const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "Search";
    return { icon, verb, primary: pattern ?? extractPath(obj) ?? "—" };
  }

  if (toolName === TOOL_AST_GREP_REPLACE) {
    const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
    return { icon, verb: "AST Replace", primary: pattern ?? extractPath(obj) ?? "—" };
  }

  // Git tools
  if (toolName === TOOL_GIT_STATUS) {
    const cwd = typeof obj.workdir === "string" ? obj.workdir : undefined;
    return { icon, verb: "Status", primary: cwd ?? "—" };
  }
  if (toolName === TOOL_GIT_DIFF) {
    const cwd = typeof obj.workdir === "string" ? obj.workdir : undefined;
    return { icon, verb: "Diff", primary: cwd ?? "—" };
  }

  // Delegate: task description
  if (toolName === TOOL_DELEGATE) {
    const task = typeof obj.task === "string" ? obj.task : undefined;
    const description = typeof obj.description === "string" ? obj.description : undefined;
    return { icon, verb: "Delegate", primary: truncate(task ?? description ?? "—", INLINE_VALUE_MAX_CHARS) };
  }

  // Web fetch: url
  if (toolName === TOOL_WEB_FETCH) {
    const url = typeof obj.url === "string" ? obj.url : undefined;
    return { icon, verb: "Fetch", primary: url ?? "—" };
  }

  // LSP tools: path
  if (toolName === TOOL_LSP_DIAGNOSTICS || toolName === TOOL_LSP_GOTO_DEFINITION || toolName === TOOL_LSP_FIND_REFERENCES || toolName === TOOL_LSP_SYMBOLS) {
    const path = extractPath(obj);
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "LSP";
    return { icon, verb, primary: path ?? "—" };
  }

  // Memory tools
  if (toolName === TOOL_MEMORY_READ || toolName === TOOL_MEMORY_WRITE) {
    const topic = typeof obj.topic === "string" ? obj.topic : undefined;
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "Memory";
    return { icon, verb, primary: topic ?? extractPath(obj) ?? "—" };
  }

  // Workflow tools
  if (toolName === TOOL_WORKFLOW_CREATE || toolName === TOOL_WORKFLOW_READ || toolName === TOOL_WORKFLOW_UPDATE_STAGE || toolName === TOOL_WORKFLOW_TASK_CHECK) {
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "Workflow";
    const name = typeof obj.name === "string" ? obj.name : undefined;
    return { icon, verb, primary: name ?? "—" };
  }

  // Artifact tools
  if (toolName === TOOL_ARTIFACT_READ || toolName === TOOL_ARTIFACT_WRITE) {
    const name = typeof obj.name === "string" ? obj.name : undefined;
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "Artifact";
    if (toolName === TOOL_ARTIFACT_WRITE && typeof obj.content === "string") {
      return { icon, verb, primary: name ?? "—", secondary: summarizeContent(obj.content) };
    }
    return { icon, verb, primary: name ?? "—" };
  }

  // Skill tools
  if (toolName === TOOL_SKILL_LIST || toolName === TOOL_SKILL_READ) {
    const skillName = typeof obj.name === "string" ? obj.name : undefined;
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? "Skill";
    return { icon, verb, primary: skillName ?? "—" };
  }

  // Delegation helpers
  if (toolName === TOOL_WAIT_FOR_REMINDER || toolName === TOOL_BACKGROUND_OUTPUT || toolName === TOOL_VIEW_TOOL_OUTPUT) {
    const verb = BUILTIN_VERBS[toolName as BuiltinToolName] ?? toolName;
    return { icon, verb, primary: "—" };
  }

  // Interaction tools
  if (toolName === TOOL_TODO_WRITE) {
    return { icon, verb: "Todo", primary: "—" };
  }
  if (toolName === TOOL_ASK_USER) {
    const question = typeof obj.question === "string" ? obj.question : undefined;
    return { icon, verb: "Ask", primary: question ? truncate(question, INLINE_VALUE_MAX_CHARS) : "—" };
  }

  // Fallback for known builtins not explicitly handled
  if (isBuiltinToolName(toolName)) {
    return { icon, verb: BUILTIN_VERBS[toolName] ?? toolName, primary: extractPath(obj) ?? firstMeaningfulString(obj) ?? "—" };
  }

  // Unknown tool
  return { icon, verb: toolName, primary: firstMeaningfulString(obj) ?? "—" };
}

// ─── Detail fields allowlist ───

const DETAIL_FIELDS_BY_TOOL: Partial<Record<BuiltinToolName, string[]>> = {
  [TOOL_FILE_READ]: ["filePath", "path", "offset", "limit"],
  [TOOL_FILE_WRITE]: ["filePath", "path"],
  [TOOL_FILE_EDIT]: ["filePath", "path"],
  [TOOL_GREP]: ["pattern", "include", "path", "output_mode"],
  [TOOL_GLOB]: ["pattern", "path"],
  [TOOL_AST_GREP_SEARCH]: ["pattern", "lang", "paths"],
  [TOOL_AST_GREP_REPLACE]: ["pattern", "lang", "paths"],
  [TOOL_BASH]: ["description", "command", "cwd", "timeoutMs"],
  [TOOL_GIT_STATUS]: ["workdir"],
  [TOOL_GIT_DIFF]: ["workdir"],
  [TOOL_WEB_FETCH]: ["url", "format", "timeout"],
  [TOOL_LSP_DIAGNOSTICS]: ["filePath", "path"],
  [TOOL_LSP_GOTO_DEFINITION]: ["filePath", "path", "line", "character"],
  [TOOL_LSP_FIND_REFERENCES]: ["filePath", "path", "line", "character"],
  [TOOL_LSP_SYMBOLS]: ["filePath", "query", "scope"],
  [TOOL_DELEGATE]: ["task", "description"],
  [TOOL_TODO_WRITE]: [],
  [TOOL_ASK_USER]: ["question"],
  [TOOL_MEMORY_READ]: ["topic", "path"],
  [TOOL_MEMORY_WRITE]: ["topic", "path"],
  [TOOL_WORKFLOW_CREATE]: ["name"],
  [TOOL_WORKFLOW_READ]: ["name"],
  [TOOL_WORKFLOW_UPDATE_STAGE]: ["name", "stage"],
  [TOOL_WORKFLOW_TASK_CHECK]: ["name"],
  [TOOL_ARTIFACT_READ]: ["name"],
  [TOOL_ARTIFACT_WRITE]: ["name"],
  [TOOL_SKILL_LIST]: [],
  [TOOL_SKILL_READ]: ["name"],
  [TOOL_WAIT_FOR_REMINDER]: [],
  [TOOL_BACKGROUND_OUTPUT]: ["taskId"],
  [TOOL_VIEW_TOOL_OUTPUT]: ["taskId"],
};

const CONTENT_FIELDS = new Set(["content", "oldString", "newString", "edits"]);

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    const lines = value.split("\n");
    if (value.length > CONTENT_SUMMARY_THRESHOLD_CHARS || lines.length > CONTENT_SUMMARY_THRESHOLD_LINES) {
      return `${value.length} chars, ${lines.length} lines`;
    }
    if (value.length > INLINE_VALUE_MAX_CHARS) {
      return value.slice(0, INLINE_VALUE_MAX_CHARS) + "…";
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > INLINE_VALUE_MAX_CHARS ? json.slice(0, INLINE_VALUE_MAX_CHARS) + "…" : json;
  } catch {
    return String(value);
  }
}

export function formatToolInputDetails(
  toolName: string,
  input: unknown,
): Record<string, string> | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) return null;

  const obj = input as Record<string, unknown>;

  // MCP tools: show server/tool + primary value
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.slice(5).split("__");
    const result: Record<string, string> = {};
    result.tool = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join("__")}` : toolName;
    const primary = firstMeaningfulString(obj);
    if (primary) result.input = primary;
    return result;
  }

  // Builtin tools: allowlist
  if (isBuiltinToolName(toolName)) {
    const allowedFields = DETAIL_FIELDS_BY_TOOL[toolName];
    if (!allowedFields) return null;

    const result: Record<string, string> = {};
    for (const field of allowedFields) {
      if (field in obj) {
        result[field] = formatDetailValue(obj[field]);
      }
    }

    // Content-like fields: always show stats only
    if (toolName === TOOL_FILE_WRITE && typeof obj.content === "string") {
      result.content = summarizeContent(obj.content);
    }
    if (toolName === TOOL_ARTIFACT_WRITE && typeof obj.content === "string") {
      result.content = summarizeContent(obj.content);
    }
    if (toolName === TOOL_MEMORY_WRITE && typeof obj.content === "string") {
      result.content = summarizeContent(obj.content);
    }
    if (toolName === TOOL_FILE_EDIT && Array.isArray(obj.edits)) {
      result.edits = `[${obj.edits.length} edit${obj.edits.length === 1 ? "" : "s"}]`;
      for (const [idx, edit] of obj.edits.entries()) {
        if (typeof edit === "object" && edit !== null) {
          const e = edit as Record<string, unknown>;
          if (typeof e.oldString === "string") {
            const lines = e.oldString.split("\n");
            result[`edits[${idx}].oldString`] = `${e.oldString.length} chars, ${lines.length} lines`;
          }
          if (typeof e.newString === "string") {
            const lines = e.newString.split("\n");
            result[`edits[${idx}].newString`] = `${e.newString.length} chars, ${lines.length} lines`;
          }
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  // Unknown tools: show first few fields
  const entries = Object.entries(obj).slice(0, 3);
  if (entries.length === 0) return null;
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (CONTENT_FIELDS.has(key)) {
      if (typeof value === "string") {
        result[key] = summarizeContent(value);
      }
    } else {
      result[key] = formatDetailValue(value);
    }
  }
  return result;
}

// ─── Diff metadata ───

export function getToolDiffMetadata(meta: unknown): ToolDiffMetadata | undefined {
  if (meta === null || meta === undefined) return undefined;
  if (typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const obj = meta as Record<string, unknown>;
  if (obj.version !== 1) return undefined;
  if (!Array.isArray(obj.files)) return undefined;
  return obj as unknown as ToolDiffMetadata;
}

// ─── Invalid input messages ───

export function getToolInvalidInputMessage(toolName: string, input: unknown): string | null {
  if (input === null || input === undefined) {
    return `Invalid ${toolName} input: missing input`;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return `Invalid ${toolName} input: expected object, got ${Array.isArray(input) ? "array" : typeof input}`;
  }

  const obj = input as Record<string, unknown>;

  if (toolName === TOOL_BASH) {
    if (!obj.command || typeof obj.command !== "string") {
      return `Invalid bash input: missing required command`;
    }
    if (!obj.description || typeof obj.description !== "string" || obj.description.trim() === "") {
      return `Invalid bash input: missing required description`;
    }
  }

  if (toolName === TOOL_FILE_WRITE || toolName === TOOL_FILE_EDIT) {
    const path = obj.filePath ?? obj.file_path ?? obj.path;
    if (!path || typeof path !== "string") {
      return `Invalid ${toolName} input: missing required file path`;
    }
  }

  if (toolName === TOOL_FILE_READ) {
    const path = obj.filePath ?? obj.file_path ?? obj.path;
    if (!path || typeof path !== "string") {
      return `Invalid file_read input: missing required file path`;
    }
  }

  if (toolName === TOOL_DELEGATE) {
    if (!obj.task || typeof obj.task !== "string") {
      return `Invalid delegate input: missing required task`;
    }
  }

  return null;
}