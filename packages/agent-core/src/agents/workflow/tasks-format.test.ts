import { describe, expect, test } from "bun:test";

const examplesRoot = `${import.meta.dir}/../../../../../docs/examples`;

import {
  calculateReadyWave,
  parseTasksMarkdown,
  toggleTaskCheckbox,
  validateTasksMarkdown,
} from "./tasks-format";

const VALID_TASKS = `# TASKS

- [ ] T1. Build parser

  Agent: builder
  Dependencies: none
  Description: Create the shared parser.
  Acceptance:
    - [ ] Parser returns task data
    - [ ] Typecheck passes
  QA:
    - [ ] Manual review done

- [x] T2. Review parser

  Agent: reviewer
  Dependencies: T1
  Description: Review the parser.
  Acceptance:
    - [ ] Code reviewed
  QA:
    - [ ] No issues found

- [ ] T3. Integrate parser

  Agent: builder
  Dependencies: T1, T2
  Description: Wire parser into callers.
  Acceptance:
    - [ ] Integration complete
  QA:
    - [ ] Smoke tested
`;

describe("parseTasksMarkdown", () => {
  test("returns top-level task data and ignores nested checkboxes", () => {
    const tasks = parseTasksMarkdown(VALID_TASKS);

    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual({
      id: "T1",
      title: "Build parser",
      checked: false,
      agent: "builder",
      dependencies: [],
      description: "Create the shared parser.",
      acceptance: ["Parser returns task data", "Typecheck passes"],
      qa: ["Manual review done"],
      lines: {
        start: 3,
        end: 12,
        checkbox: 3,
        agent: 5,
        dependencies: 6,
        description: 7,
        acceptance: 8,
        qa: 11,
      },
    });
    expect(tasks.map((task) => task.id)).toEqual(["T1", "T2", "T3"]);
  });
});

describe("validateTasksMarkdown", () => {
  test("accepts the fixed TASKS.md format", () => {
    const result = validateTasksMarkdown(VALID_TASKS);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tasks).toHaveLength(3);
  });

  test("reports malformed top-level checkboxes and missing required fields", () => {
    const result = validateTasksMarkdown(`- [ ] Task without id

  Agent: builder
  Dependencies: none
  Description: Bad task
`);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_TASK_HEADING", line: 1 }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "MISSING_FIELD", taskId: "unknown", field: "Acceptance" }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "MISSING_FIELD", taskId: "unknown", field: "QA" }),
    );
  });

  test("rejects dependencies that do not reference declared top-level tasks", () => {
    const result = validateTasksMarkdown(`- [ ] T1. Build parser

  Agent: builder
  Dependencies: T9
  Description: Create the shared parser.
  Acceptance:
    - [ ] Parser returns task data
  QA:
    - [ ] Manual review done
`);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_DEPENDENCY", taskId: "T1", dependencyId: "T9" }),
    );
  });

  test("detects circular dependencies and reports involved task ids", () => {
    const result = validateTasksMarkdown(`- [ ] T1. First

  Agent: builder
  Dependencies: T3
  Description: First task.
  Acceptance:
    - [ ] Done
  QA:
    - [ ] Checked

- [ ] T2. Second

  Agent: builder
  Dependencies: T1
  Description: Second task.
  Acceptance:
    - [ ] Done
  QA:
    - [ ] Checked

- [ ] T3. Third

  Agent: builder
  Dependencies: T2
  Description: Third task.
  Acceptance:
    - [ ] Done
  QA:
    - [ ] Checked
`);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "CIRCULAR_DEPENDENCY", taskIds: ["T1", "T3", "T2"] }),
    );
  });

  test("validates checked-in TASKS.md examples", async () => {
    const validExample = await Bun.file(`${examplesRoot}/tasks-valid.md`).text();
    const missingFieldsExample = await Bun.file(`${examplesRoot}/tasks-invalid-missing-fields.md`).text();
    const circularExample = await Bun.file(`${examplesRoot}/tasks-invalid-circular.md`).text();

    const validResult = validateTasksMarkdown(validExample);
    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toEqual([]);
    expect(validResult.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies }))).toEqual([
      { id: "T1", dependencies: [] },
      { id: "T2", dependencies: [] },
      { id: "T3", dependencies: ["T1", "T2"] },
    ]);

    const missingFieldsResult = validateTasksMarkdown(missingFieldsExample);
    expect(missingFieldsResult.valid).toBe(false);
    expect(missingFieldsResult.errors).toContainEqual(
      expect.objectContaining({ code: "MISSING_FIELD", taskId: "T1", field: "QA" }),
    );
    expect(missingFieldsResult.errors).toContainEqual(
      expect.objectContaining({ code: "MISSING_FIELD", taskId: "T2", field: "Description" }),
    );

    const circularResult = validateTasksMarkdown(circularExample);
    expect(circularResult.valid).toBe(false);
    expect(circularResult.errors).toContainEqual(
      expect.objectContaining({ code: "CIRCULAR_DEPENDENCY", taskIds: ["T1", "T3", "T2"] }),
    );
  });
});

describe("calculateReadyWave", () => {
  test("returns unchecked tasks whose dependencies are checked or none", () => {
    const tasks = parseTasksMarkdown(VALID_TASKS);

    expect(calculateReadyWave(tasks).map((task) => task.id)).toEqual(["T1"]);

    const withT1Checked = tasks.map((task) =>
      task.id === "T1" ? { ...task, checked: true } : task,
    );
    expect(calculateReadyWave(withT1Checked).map((task) => task.id)).toEqual(["T3"]);
  });
});

describe("toggleTaskCheckbox", () => {
  test("toggles only top-level task checkboxes", () => {
    const updated = toggleTaskCheckbox(VALID_TASKS, "T1", true);

    expect(updated).toContain("- [x] T1. Build parser");
    expect(updated).toContain("    - [ ] Parser returns task data");
  });

  test("rejects unknown task ids and malformed content", () => {
    expect(() => toggleTaskCheckbox(VALID_TASKS, "T9", true)).toThrow(/Unknown task id/);
    expect(() => toggleTaskCheckbox("not tasks", "T1", true)).toThrow(/valid TASKS\.md/);
  });
});
