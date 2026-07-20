import { describe, expect, test } from "bun:test";
import { PromptLiveEvalManifestSchema, PromptLiveEvalScenariosSchema, runPromptLiveEval } from "./live-eval";

describe("Prompt live eval contract", () => {
  test("requires an explicit qualified model manifest and result path", () => {
    expect(() => PromptLiveEvalManifestSchema.parse({ version: 1, models: [], resultPath: "results.json" })).toThrow();
    expect(() => PromptLiveEvalManifestSchema.parse({ version: 1, models: [{ qualifiedId: "guessed" }], resultPath: "results.json" })).toThrow();
    expect(PromptLiveEvalManifestSchema.parse({ version: 1, models: [{ qualifiedId: "local:model" }], resultPath: "artifacts/prompt-live-eval/results.json" }).models)
      .toEqual([{ qualifiedId: "local:model" }]);
  });

  test("runs only manifest models over fixed scenarios and returns machine-readable results", async () => {
    const manifest = PromptLiveEvalManifestSchema.parse({ version: 1, models: [{ qualifiedId: "a:one" }, { qualifiedId: "b:two" }], resultPath: "results.json" });
    const fixture = PromptLiveEvalScenariosSchema.parse({ version: 1, scenarios: [{
      id: "direct", agent: "engineer", executionMode: "ordinary-root",
      request: "Small task", expectedAny: ["direct"], forbidden: ["delegate"],
    }] });
    const calls: string[] = [];
    const systems: string[] = [];
    const result = await runPromptLiveEval(manifest, fixture, async (model, system) => {
      calls.push(model);
      systems.push(system);
      return "Work directly";
    });

    expect(calls).toEqual(["a:one", "b:two"]);
    expect(result.models).toEqual(calls);
    expect(result.scenarios.map(({ passed }) => passed)).toEqual([true, true]);
    expect(systems.every((system) => system.includes("## Shared Kernel"))).toBe(true);
    expect(systems.every((system) => system.includes("Agent: engineer"))).toBe(true);
    expect(systems.every((system) => !system.includes("Model Overlay"))).toBe(true);
    expect(systems[0]).toBe(systems[1]);
  });

  test("fixed fixture compiles Engineer, delegated final-output, and Reviewer scenarios through the sole V2 compiler", async () => {
    const fixture = PromptLiveEvalScenariosSchema.parse(
      await Bun.file(new URL("./live-eval-scenarios.json", import.meta.url)).json(),
    );
    const manifest = PromptLiveEvalManifestSchema.parse({ version: 1, models: [{ qualifiedId: "local:test" }], resultPath: "results.json" });
    const calls: Array<{ system: string; prompt: string }> = [];
    await runPromptLiveEval(manifest, fixture, async (_model, system, prompt) => {
      calls.push({ system, prompt });
      if (prompt.includes("typo")) return "direct";
      if (prompt.includes("independent")) return "parallel";
      if (prompt.includes("resulting diff")) return "then review after implementation";
      if (prompt.includes("Finish the delegated scope")) return "normal final response";
      if (prompt.includes("ordinary delegated")) return "VERDICT: APPROVED";
      if (prompt.includes("Independently review")) return "VERDICT: CHANGES_REQUESTED";
      if (prompt.includes("working autonomously") || prompt.includes("Take ownership")) return "CREATE_GOAL";
      if (prompt.includes("until it is better")) return "ASK_CLARIFY";
      if (prompt.includes("Classify the following")) return "NO_GOAL";
      return "normal final response";
    });

    expect(calls).toHaveLength(14);
    expect(calls.every(({ system }) => system.includes("## Shared Kernel"))).toBe(true);
    expect(calls.slice(0, 3).every(({ system }) => system.includes("Agent: engineer"))).toBe(true);
    expect(calls[3]!.system).toContain("Role Contract: Build");
    expect(calls[3]!.system).toContain("normal assistant response");
    expect(calls[4]!.system).toContain("Completion authority: reviewer");
    expect(calls[5]!.system).toContain("VERDICT: APPROVED");
    expect(calls[5]!.system).not.toContain("submit_child_result");
    expect(calls.slice(6).every(({ system }) => system.includes("create_goal"))).toBe(true);
    expect(calls.slice(6).every(({ prompt }) => prompt.includes("Reply with exactly CREATE_GOAL"))).toBe(true);
  });
});
