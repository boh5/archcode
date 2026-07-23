import {
  getToolCategory,
  type ToolCategory,
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
import { summarizeToolInput } from "./tool-input-presentation";

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

export interface ToolDiffSummary {
  fileCount: number;
  additions?: number;
  deletions?: number;
}

export function getToolSummary(toolName: string, input: unknown): ToolSummary {
  const category = getToolCategory(toolName);
  const icon = getToolIcon(category);
  return { icon, ...summarizeToolInput(input) };
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

export function summarizeToolDiffMetadata(metadata: ToolDiffMetadata): ToolDiffSummary {
  const hasCompleteCounts = metadata.files.length > 0
    && metadata.files.every((file) => Number.isFinite(file.additions) && Number.isFinite(file.deletions));

  if (!hasCompleteCounts) return { fileCount: metadata.files.length };

  return {
    fileCount: metadata.files.length,
    additions: metadata.files.reduce((total, file) => total + (file.additions as number), 0),
    deletions: metadata.files.reduce((total, file) => total + (file.deletions as number), 0),
  };
}
