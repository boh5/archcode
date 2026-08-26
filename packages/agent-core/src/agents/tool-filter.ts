import { TOOL_TOOL_SEARCH } from "@archcode/protocol";
import type { ToolRegistry } from "../tools/registry";
import type { AgentDefinition } from "./factory-types";
import { DELEGATION_CONTROL_TOOLS } from "./constants";

const DELEGATION_CONTROL_TOOL_NAMES = new Set<string>(DELEGATION_CONTROL_TOOLS);

/**
 * Raised when an AgentDefinition would make the role contract and runtime
 * authority disagree. Definitions are validated both when authored and when
 * registered by the factory so dynamically supplied catalogs get the same
 * hard-cut checks as the builtins.
 */
export class AgentDefinitionValidationError extends Error {
  constructor(
    public readonly definitionName: string,
    public readonly violations: readonly string[],
  ) {
    super(`Invalid agent definition "${definitionName}": ${violations.join("; ")}`);
    this.name = "AgentDefinitionValidationError";
  }
}

/**
 * Definition helper with a type-level core-subset check and runtime
 * duplicate/contract validation.
 */
export function defineAgentDefinition<const Definition extends AgentDefinition>(
  definition: Definition & (
    Exclude<Definition["tools"]["core"][number], Definition["tools"]["authorized"][number]> extends never
      ? unknown
      : { readonly tools: never }
  ),
): Definition {
  validateAgentDefinition(definition);
  return definition;
}

/** Validate the immutable authority contract owned by one Agent definition. */
export function validateAgentDefinition(definition: AgentDefinition): void {
  const violations: string[] = [];
  const authorized = [...definition.tools.authorized];
  const core = [...definition.tools.core];
  const authorizedSet = new Set(authorized);

  for (const duplicate of duplicateNames(authorized)) {
    violations.push(`tools.authorized contains duplicate tool: ${duplicate}`);
  }
  for (const duplicate of duplicateNames(core)) {
    violations.push(`tools.core contains duplicate tool: ${duplicate}`);
  }
  for (const toolName of core) {
    if (!authorizedSet.has(toolName)) {
      violations.push(`tools.core contains unauthorized tool: ${toolName}`);
    }
  }
  if (core.includes(TOOL_TOOL_SEARCH)) {
    violations.push("tools.core must not contain tool_search");
  }

  for (const capability of definition.roleContract.requiredCapabilities) {
    if (!authorizedSet.has(capability)) {
      violations.push(`required capability is not authorized: ${capability}`);
    }
  }
  for (const capability of definition.roleContract.forbiddenCapabilities) {
    if (authorizedSet.has(capability)) {
      violations.push(`forbidden capability is authorized: ${capability}`);
    }
  }

  if (violations.length > 0) {
    throw new AgentDefinitionValidationError(definition.name, violations);
  }
}

/**
 * Remove delegation controls when this Agent cannot create another child.
 * Callers may use this for both the definition projection and an explicit
 * execution overlay; an overlay must never re-grant a depth-filtered control.
 */
export function filterToolsByDepth(
  tools: readonly string[],
  definition: AgentDefinition,
  depth: number,
): string[] {
  const unique = [...new Set(tools)];
  if (canDelegateAtDepth(definition, depth)) return unique;
  return unique.filter((toolName) => !DELEGATION_CONTROL_TOOL_NAMES.has(toolName));
}

export function canDelegateAtDepth(definition: AgentDefinition, depth: number): boolean {
  return definition.tools.authorized.includes(DELEGATION_CONTROL_TOOLS[0])
    && definition.childPolicy !== undefined
    && (definition.tools.delegateTargets?.length ?? 0) > 0
    && depth < definition.childPolicy.maxDepth;
}

export function isDelegationControlTool(toolName: string): boolean {
  return DELEGATION_CONTROL_TOOL_NAMES.has(toolName);
}

/** Resolve registered definition-authorized descriptors and apply depth policy. */
export function resolveDefinitionAllowedTools(
  toolRegistry: Pick<ToolRegistry, "resolveForAgent">,
  definition: AgentDefinition,
  depth: number,
): string[] {
  const resolved = toolRegistry.resolveForAgent(definition.tools.authorized).descriptors;
  return filterToolsByDepth(resolved.map((tool) => tool.name), definition, depth);
}

function duplicateNames(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}
