export const TOOL_INPUT_MAX_DEPTH = 5;
export const TOOL_INPUT_MAX_NODES = 200;
export const TOOL_INPUT_STRING_PREVIEW_CHARS = 160;
export const TOOL_INPUT_STRING_PREVIEW_LINES = 4;
const TOOL_INPUT_SUMMARY_MAX_NODES = 32;

export interface ToolInputNode {
  readonly key?: string;
  readonly kind: "value" | "object" | "array";
  readonly value: string;
  readonly children?: readonly ToolInputNode[];
  readonly omittedChildren?: number;
  readonly truncated?: boolean;
}

export interface ToolInputSummary {
  readonly primary: string;
  readonly secondary?: string;
}

interface BuildContext {
  nodeCount: number;
  readonly ancestors: WeakSet<object>;
}

interface SummaryContext {
  visitedNodes: number;
  readonly ancestors: WeakSet<object>;
}

function formatSummaryString(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const lines = value.split("\n");
  if (value.length > TOOL_INPUT_STRING_PREVIEW_CHARS || lines.length > TOOL_INPUT_STRING_PREVIEW_LINES) {
    return `${value.length} chars, ${lines.length} lines`;
  }
  return value.replace(/\s+/g, " ").trim();
}

function collectSummaryValues(
  value: unknown,
  values: string[],
  context: SummaryContext,
  depth: number,
): void {
  if (
    values.length >= 2
    || context.visitedNodes >= TOOL_INPUT_SUMMARY_MAX_NODES
    || depth > 3
    || value === null
    || value === undefined
  ) return;
  context.visitedNodes += 1;
  if (typeof value === "string") {
    const formatted = formatSummaryString(value);
    if (formatted !== undefined) values.push(formatted);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    values.push(String(value));
    return;
  }
  if (typeof value !== "object" || context.ancestors.has(value)) return;

  context.ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    collectSummaryValues(child, values, context, depth + 1);
    if (values.length >= 2 || context.visitedNodes >= TOOL_INPUT_SUMMARY_MAX_NODES) break;
  }
  context.ancestors.delete(value);
}

export function summarizeToolInput(input: unknown): ToolInputSummary {
  if (input === null || input === undefined) return { primary: "—" };

  const values: string[] = [];
  collectSummaryValues(input, values, {
    visitedNodes: 0,
    ancestors: new WeakSet<object>(),
  }, 0);
  if (values.length > 0) {
    return {
      primary: values[0]!,
      secondary: values[1],
    };
  }

  if (Array.isArray(input)) {
    return { primary: `[${input.length} ${input.length === 1 ? "item" : "items"}]` };
  }
  if (typeof input === "object") {
    const count = Object.keys(input).length;
    return { primary: `{${count} ${count === 1 ? "field" : "fields"}}` };
  }
  return { primary: formatPrimitive(input) };
}

function formatPrimitive(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return formatString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  return String(value);
}

function formatString(value: string): string {
  const lines = value.split("\n");
  const previewByLines = lines.slice(0, TOOL_INPUT_STRING_PREVIEW_LINES).join("\n");
  const preview = previewByLines.slice(0, TOOL_INPUT_STRING_PREVIEW_CHARS);
  const truncated = preview.length < value.length;
  const encodedPreview = JSON.stringify(truncated ? `${preview}…` : preview);

  if (!truncated) return encodedPreview;
  return `${encodedPreview} · ${value.length} chars, ${lines.length} lines · truncated`;
}

function containerSummary(value: readonly unknown[] | Record<string, unknown>): string {
  if (Array.isArray(value)) {
    return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  }
  const count = Object.keys(value).length;
  return `{${count} ${count === 1 ? "field" : "fields"}}`;
}

function buildNode(
  value: unknown,
  key: string | undefined,
  depth: number,
  context: BuildContext,
): ToolInputNode {
  context.nodeCount += 1;

  if (value === null || typeof value !== "object") {
    return { key, kind: "value", value: formatPrimitive(value) };
  }

  const kind = Array.isArray(value) ? "array" : "object";
  const summary = containerSummary(value as readonly unknown[] | Record<string, unknown>);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [`[${index}]`, entry] as const)
    : Object.entries(value as Record<string, unknown>);

  if (context.ancestors.has(value)) {
    return { key, kind, value: `${summary} · circular reference`, truncated: true };
  }

  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return {
      key,
      kind,
      value: entries.length > 0 ? `${summary} · depth limit` : summary,
      omittedChildren: entries.length,
      truncated: entries.length > 0,
    };
  }

  context.ancestors.add(value);
  const children: ToolInputNode[] = [];
  let omittedChildren = 0;

  for (const [childKey, childValue] of entries) {
    if (context.nodeCount >= TOOL_INPUT_MAX_NODES) {
      omittedChildren = entries.length - children.length;
      break;
    }
    children.push(buildNode(childValue, childKey, depth + 1, context));
  }

  context.ancestors.delete(value);
  return {
    key,
    kind,
    value: summary,
    children,
    omittedChildren: omittedChildren || undefined,
    truncated: omittedChildren > 0 || undefined,
  };
}

export function buildToolInputTree(input: unknown): ToolInputNode {
  return buildNode(input, undefined, 0, {
    nodeCount: 0,
    ancestors: new WeakSet<object>(),
  });
}
