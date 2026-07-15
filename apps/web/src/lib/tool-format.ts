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
  TOOL_AST_GREP_SEARCH,
  TOOL_AST_GREP_REPLACE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_RESUME_SESSION,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
} from "@archcode/protocol";
import type { ToolDiffMetadata } from "@archcode/protocol";
import type { LucideIcon } from "lucide-react";
import {
  FileText,
  Pencil,
  Search,
  GitBranch,
  Terminal,
  MessageSquare,
  Wrench,
  Globe,
  Handshake,
  Zap,
  Brain,
  Plug,
  CircleQuestionMark,
  Target,
  Clock,
} from "lucide-react";

// ─── Threshold constants ───

export const INLINE_VALUE_MAX_CHARS = 160;
export const INLINE_VALUE_MAX_LINES = 4;
export const CONTENT_SUMMARY_THRESHOLD_CHARS = 200;
export const CONTENT_SUMMARY_THRESHOLD_LINES = 8;

// ─── Tool icon map ───

const CATEGORY_ICONS: Record<ToolCategory, LucideIcon> = {
  fileRead: FileText,
  fileWrite: Pencil,
  search: Search,
  git: GitBranch,
  shell: Terminal,
  interaction: MessageSquare,
  lsp: Wrench,
  web: Globe,
  delegation: Handshake,
  skill: Zap,
  memory: Brain,
  goal: Target,
  automation: Clock,
  mcp: Plug,
  other: CircleQuestionMark,
};

export function getToolIcon(category: ToolCategory): LucideIcon {
  return CATEGORY_ICONS[category] ?? CircleQuestionMark;
}

// ─── Tool summary model ───

export interface ToolSummary {
  icon: LucideIcon;
  primary: string;
  secondary?: string;
}



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
    return { icon, primary: "—" };
  }

  if (typeof input === "string") {
    return { icon, primary: truncate(input, INLINE_VALUE_MAX_CHARS) };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return { icon, primary: String(input) };
  }

  const obj = input as Record<string, unknown>;

  // MCP tools: server/tool · primary value
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.slice(5).split("__");
    const serverTool = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join("__")}` : toolName;
    const primary = firstMeaningfulString(obj) ?? serverTool;
    return { icon, primary };
  }

  // Bash: two-part model (description + command)
  if (toolName === TOOL_BASH) {
    const description = typeof obj.description === "string" ? obj.description : undefined;
    const command = typeof obj.command === "string" ? obj.command : undefined;
    return {
      icon,
      primary: description ?? command ?? "—",
      secondary: description && command ? truncate(command, INLINE_VALUE_MAX_CHARS) : undefined,
    };
  }

  // File tools: path
  if (toolName === TOOL_FILE_READ || toolName === TOOL_FILE_WRITE || toolName === TOOL_FILE_EDIT) {
    const path = extractPath(obj);
    if (toolName === TOOL_FILE_WRITE && typeof obj.content === "string") {
      return { icon, primary: path ?? "—", secondary: summarizeContent(obj.content) };
    }
    return { icon, primary: path ?? "—" };
  }

  // Search tools: pattern
  if (toolName === TOOL_GREP || toolName === TOOL_GLOB || toolName === TOOL_AST_GREP_SEARCH) {
    const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
    return { icon, primary: pattern ?? extractPath(obj) ?? "—" };
  }

  if (toolName === TOOL_AST_GREP_REPLACE) {
    const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
    return { icon, primary: pattern ?? extractPath(obj) ?? "—" };
  }

  // Git tools
  if (toolName === TOOL_GIT_STATUS) {
    const cwd = typeof obj.workdir === "string" ? obj.workdir : undefined;
    return { icon, primary: cwd ?? "—" };
  }
  if (toolName === TOOL_GIT_DIFF) {
    const cwd = typeof obj.workdir === "string" ? obj.workdir : undefined;
    return { icon, primary: cwd ?? "—" };
  }

  // Delegate: agent_type: title summary
  if (toolName === TOOL_DELEGATE) {
    const agentType = typeof obj.agent_type === "string" ? obj.agent_type : undefined;
    const title = typeof obj.title === "string" ? obj.title : undefined;
    const task = typeof obj.task === "string" ? obj.task : undefined;
    if (agentType && title) {
      return { icon, primary: `${agentType}: ${truncate(title, INLINE_VALUE_MAX_CHARS)}`, secondary: task ? truncate(task, INLINE_VALUE_MAX_CHARS) : undefined };
    }
    return { icon, primary: truncate(title ?? agentType ?? "—", INLINE_VALUE_MAX_CHARS), secondary: task ? truncate(task, INLINE_VALUE_MAX_CHARS) : undefined };
  }

  // Web fetch: url
  if (toolName === TOOL_WEB_FETCH) {
    const url = typeof obj.url === "string" ? obj.url : undefined;
    return { icon, primary: url ?? "—" };
  }

  // LSP tools: path
  if (toolName === TOOL_LSP_DIAGNOSTICS || toolName === TOOL_LSP_GOTO_DEFINITION || toolName === TOOL_LSP_FIND_REFERENCES || toolName === TOOL_LSP_SYMBOLS) {
    const path = extractPath(obj);
    return { icon, primary: path ?? "—" };
  }

  // Memory tools
  if (toolName === TOOL_MEMORY_READ || toolName === TOOL_MEMORY_WRITE) {
    const topic = typeof obj.topic === "string" ? obj.topic : undefined;
    return { icon, primary: topic ?? extractPath(obj) ?? "—" };
  }

  // Skill tools
  if (toolName === TOOL_SKILL_LIST || toolName === TOOL_SKILL_READ) {
    const skillName = typeof obj.name === "string" ? obj.name : undefined;
    return { icon, primary: skillName ?? "—" };
  }

  // Delegation helpers
  if (toolName === TOOL_BACKGROUND_OUTPUT) {
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    return { icon, primary: sessionId ?? "—" };
  }
  if (toolName === TOOL_RESUME_SESSION) {
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    const task = typeof obj.task === "string" ? obj.task : undefined;
    return { icon, primary: sessionId ?? "—", secondary: task ? truncate(task, INLINE_VALUE_MAX_CHARS) : undefined };
  }
  if (toolName === TOOL_WAIT_FOR_REMINDER || toolName === TOOL_VIEW_TOOL_OUTPUT) {
    return { icon, primary: "—" };
  }

  // Interaction tools
  if (toolName === TOOL_TODO_WRITE) {
    return { icon, primary: "—" };
  }
  if (toolName === TOOL_ASK_USER) {
    const firstQuestion = Array.isArray(obj.questions) ? obj.questions[0] : undefined;
    const structuredQuestion = firstQuestion !== null && typeof firstQuestion === "object"
      ? (firstQuestion as Record<string, unknown>).question
      : undefined;
    const question = typeof structuredQuestion === "string"
      ? structuredQuestion
      : typeof obj.question === "string" ? obj.question : undefined;
    return { icon, primary: question ? truncate(question, INLINE_VALUE_MAX_CHARS) : "—" };
  }

  // Fallback for known builtins not explicitly handled
  if (isBuiltinToolName(toolName)) {
    return { icon, primary: extractPath(obj) ?? firstMeaningfulString(obj) ?? "—" };
  }

  // Unknown tool
  return { icon, primary: firstMeaningfulString(obj) ?? "—" };
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
  [TOOL_DELEGATE]: ["agent_type", "persona", "task", "context", "skills", "title", "background"],
  [TOOL_TODO_WRITE]: [],
  [TOOL_ASK_USER]: ["question"],
  [TOOL_MEMORY_READ]: ["topic", "path"],
  [TOOL_MEMORY_WRITE]: ["topic", "path"],
  [TOOL_SKILL_LIST]: [],
  [TOOL_SKILL_READ]: ["name"],
  [TOOL_WAIT_FOR_REMINDER]: [],
  [TOOL_BACKGROUND_OUTPUT]: ["session_id", "block", "timeout_ms", "full_session", "message_limit", "since_message_id", "include_tool_results", "include_reasoning"],
  [TOOL_RESUME_SESSION]: ["session_id", "task", "context", "background"],
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

function isExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowedKeys.has(key));
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isDiffLine(value: unknown): boolean {
  return isExactRecord(value, ["type", "content"])
    && (value.type === "context" || value.type === "add" || value.type === "delete")
    && typeof value.content === "string";
}

function isDiffHunk(value: unknown): boolean {
  return isExactRecord(value, ["header", "oldStart", "oldLines", "newStart", "newLines", "lines"])
    && typeof value.header === "string"
    && typeof value.oldStart === "number" && Number.isFinite(value.oldStart)
    && typeof value.oldLines === "number" && Number.isFinite(value.oldLines)
    && typeof value.newStart === "number" && Number.isFinite(value.newStart)
    && typeof value.newLines === "number" && Number.isFinite(value.newLines)
    && Array.isArray(value.lines)
    && value.lines.every(isDiffLine);
}

function isDiffFile(value: unknown): boolean {
  if (!isExactRecord(value, ["path", "hunks"], ["status", "additions", "deletions"])) return false;
  return typeof value.path === "string"
    && (value.status === undefined || value.status === "modified" || value.status === "created" || value.status === "deleted")
    && isOptionalFiniteNumber(value.additions)
    && isOptionalFiniteNumber(value.deletions)
    && Array.isArray(value.hunks)
    && value.hunks.every(isDiffHunk);
}

export function getToolDiffMetadata(meta: unknown): ToolDiffMetadata | undefined {
  if (!isExactRecord(meta, ["files"], ["truncated", "unsupportedReason", "warning"])) return undefined;
  if (!Array.isArray(meta.files) || !meta.files.every(isDiffFile)) return undefined;
  if (meta.truncated !== undefined && typeof meta.truncated !== "boolean") return undefined;
  if (meta.warning !== undefined && typeof meta.warning !== "string") return undefined;
  if (meta.unsupportedReason !== undefined
    && meta.unsupportedReason !== "binary"
    && meta.unsupportedReason !== "too_large"
    && meta.unsupportedReason !== "not_text"
    && meta.unsupportedReason !== "no_change"
    && meta.unsupportedReason !== "diff_error") return undefined;
  return meta as unknown as ToolDiffMetadata;
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
    if (!obj.agent_type || typeof obj.agent_type !== "string") {
      return `Invalid delegate input: missing required agent_type`;
    }
    if (!obj.title || typeof obj.title !== "string") {
      return `Invalid delegate input: missing required title`;
    }
    if (!obj.task || typeof obj.task !== "string") {
      return `Invalid delegate input: missing required task`;
    }
  }

  if (toolName === TOOL_RESUME_SESSION) {
    if (!obj.session_id || typeof obj.session_id !== "string") {
      return `Invalid resume_session input: missing required session_id`;
    }
    if (!obj.task || typeof obj.task !== "string") {
      return `Invalid resume_session input: missing required task`;
    }
  }

  return null;
}
