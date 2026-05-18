import { describe, expect, mock, test } from "bun:test";

import { calculateReadyWave, type ParsedTask } from "./tasks-format";
import {
  createForemanWaveTodo,
  planForemanReadyWave,
  simulateForemanWaveExecution,
} from "./foreman-wave";

const TASKS_WITH_PARALLEL_WAVE = `# TASKS

- [ ] T1. Build foundation

  Agent: builder
  Dependencies: none
  Description: Build the foundation.
  Acceptance:
    - [ ] Foundation exists
  QA:
    - [ ] Typecheck passes

- [ ] T2. Review foundation

  Agent: reviewer
  Dependencies: none
  Description: Review the foundation.
  Acceptance:
    - [ ] Review completed
  QA:
    - [ ] No blocking findings

- [ ] T3. Integrate results

  Agent: builder
  Dependencies: T1, T2
  Description: Integrate both completed tasks.
  Acceptance:
    - [ ] Integration completed
  QA:
    - [ ] Tests pass
`;

describe("Foreman Markdown-wave execution", () => {
  test("creates exactly one wave-level todo such as Wave 1: T1, T2", () => {
    const todo = createForemanWaveTodo(1, [
      { id: "T1" } as ParsedTask,
      { id: "T2" } as ParsedTask,
    ]);

    expect(todo).toEqual({
      content: "Wave 1: T1, T2",
      taskIds: ["T1", "T2"],
    });
  });

  test("delegates T1/T2 with Dependencies: none before T3 depends on T1/T2", () => {
    const result = simulateForemanWaveExecution(TASKS_WITH_PARALLEL_WAVE);

    expect(result.steps.map((step) => step.todo.content)).toEqual(["Wave 1: T1, T2", "Wave 2: T3"]);
    expect(result.steps[0]?.delegations.map((delegation) => delegation.taskId)).toEqual(["T1", "T2"]);
    expect(result.steps[0]?.delegations.map((delegation) => delegation.target)).toEqual([
      "builder",
      "reviewer",
    ]);
    expect(result.steps[1]?.delegations.map((delegation) => delegation.taskId)).toEqual(["T3"]);
    expect(result.finalTasksMarkdown).toContain("- [x] T1. Build foundation");
    expect(result.finalTasksMarkdown).toContain("- [x] T2. Review foundation");
    expect(result.finalTasksMarkdown).toContain("- [x] T3. Integrate results");
  });

  test("rereads TASKS.md after checking tasks before selecting the next wave", () => {
    const result = simulateForemanWaveExecution(TASKS_WITH_PARALLEL_WAVE);

    expect(result.steps[0]?.rereadAfterChecks).toBe(true);
    expect(result.steps[1]?.sourceRead).toContain("- [x] T1. Build foundation");
    expect(result.steps[1]?.sourceRead).toContain("- [x] T2. Review foundation");
    expect(result.steps[1]?.sourceRead).toContain("- [ ] T3. Integrate results");
  });

  test("wave selection consumes shared parser output and calculateReadyWave", () => {
    const selectReadyWave = mock((tasks: readonly ParsedTask[]) => calculateReadyWave(tasks));

    const step = planForemanReadyWave(TASKS_WITH_PARALLEL_WAVE, 1, selectReadyWave);

    expect(selectReadyWave).toHaveBeenCalledTimes(1);
    const parserOutput = selectReadyWave.mock.calls[0]?.[0];
    expect(parserOutput?.map((task) => task.id)).toEqual(["T1", "T2", "T3"]);
    expect(parserOutput?.[0]?.dependencies).toEqual([]);
    expect(parserOutput?.[2]?.dependencies).toEqual(["T1", "T2"]);
    expect(step?.todo.content).toBe("Wave 1: T1, T2");
  });
});
