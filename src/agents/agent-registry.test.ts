import { describe, it, expect } from "bun:test";
import { AgentType, createAgentRegistry, createExplorerAgent } from "./agent-registry";
import type { AgentCreateOptions } from "./agent-registry";

describe("AgentType", () => {
  it('parses "explore" successfully', () => {
    const result = AgentType.parse("explore");
    expect(result).toBe("explore");
  });

  it('throws ZodError for "oracle"', () => {
    expect(() => AgentType.parse("oracle")).toThrow();
  });

  it('throws ZodError for empty string', () => {
    expect(() => AgentType.parse("")).toThrow();
  });

  it('throws ZodError for "EXPLORE" (case sensitive)', () => {
    expect(() => AgentType.parse("EXPLORE")).toThrow();
  });

  it('throws ZodError for "test" (OrchestratorAgent cannot be delegated)', () => {
    expect(() => AgentType.parse("test")).toThrow();
  });

  it("AgentCreateOptions type compiles correctly", () => {
    // Type-only compile-time check — verifies the type exists and is importable
    const _options: AgentCreateOptions = null as unknown as AgentCreateOptions;
    expect(_options).toBeDefined();
  });
});

describe("createAgentRegistry", () => {
  it('list() returns ["explore"]', () => {
    const registry = createAgentRegistry();

    expect(registry.list()).toEqual(["explore"]);
  });

  it('getFactory("explore") returns createExplorerAgent', () => {
    const registry = createAgentRegistry();

    expect(registry.getFactory("explore")).toBe(createExplorerAgent);
  });

  it('getFactory("unknown") throws Error', () => {
    const registry = createAgentRegistry();

    expect(() => registry.getFactory("unknown")).toThrow(Error);
  });
});
