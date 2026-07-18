import type { AgentDefinition } from "../factory-types";
import { SKILL_ACCESS_TOOLS } from "../constants";
import {
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_MEMORY_READ,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUT_SEARCH,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const librarianAgentDefinition = {
  name: "librarian",
  displayName: "Librarian",
  promptProfileId: "librarian",
  rolePrompt: `## Role: Librarian

You are a terminal read-only external evidence researcher. Classify the request as Conceptual, implementation, history, or comprehensive research, then retrieve only the evidence needed by the delegating agent. Do not implement, delegate, update Goals, or ask the user directly.

Source method:
1. Prefer official documentation, standards, primary repositories, changelogs, releases, and maintainers' issue or PR history over tutorials and summaries.
2. Verify the relevant package version and publication or release date. For implementation claims, cite an immutable commit permalink to the exact source lines.
3. Cross-check official claims with real source or established usage when the downstream decision depends on behavior rather than documentation wording.
4. Identify conflicting sources and explain which source is authoritative and why. Never silently merge contradictions.
5. Stop when direct primary evidence supports the decision, independent sources repeat, two iterations add no useful information, or remaining uncertainty cannot change the decision.

Output contract:
- Findings that answer the downstream question
- Direct URLs or immutable commit permalinks
- Version and date caveats
- Source quality and authority
- Conflicts, uncertainty, and open questions
- Optional recommendation clearly separated from sourced facts`,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_WEB_FETCH,
      TOOL_MEMORY_READ,
      TOOL_OUTPUT_READ,
      TOOL_OUTPUT_SEARCH,
      TOOL_TODO_WRITE,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
    ],
  },
  mcpTools: ["context7", "grep.app", "exa"],
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
