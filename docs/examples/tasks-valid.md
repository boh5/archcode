# TASKS

- [ ] T1. Draft product workflow fixtures

  Agent: builder
  Dependencies: none
  Description: Create representative workflow fixture content for parser documentation.
  Acceptance:
    - [ ] Fixture content uses top-level TASKS.md checkboxes
    - [ ] Required fields are present for the task
  QA:
    - [ ] Parser validation accepts T1

- [ ] T2. Review parser documentation examples

  Agent: reviewer
  Dependencies: none
  Description: Review the TASKS.md examples for clarity and format consistency.
  Acceptance:
    - [ ] Examples show the required field names exactly
    - [ ] Nested Acceptance and QA checkboxes are not presented as executable tasks
  QA:
    - [ ] Reviewer confirms examples match parser expectations

- [ ] T3. Integrate example validation coverage

  Agent: builder
  Dependencies: T1, T2
  Description: Add test coverage proving the example TASKS.md files parse and validate through the shared parser.
  Acceptance:
    - [ ] Validation test checks the valid example succeeds
    - [ ] Validation test checks invalid examples fail for expected reasons
  QA:
    - [ ] `bun test src/agents/workflow/tasks-format.test.ts` passes
