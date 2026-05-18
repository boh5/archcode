# TASKS

- [ ] T1. First circular task

  Agent: builder
  Dependencies: T3
  Description: This task depends on T3 to form a cycle.
  Acceptance:
    - [ ] Cycle is detected
  QA:
    - [ ] Validation rejects this graph

- [ ] T2. Second circular task

  Agent: builder
  Dependencies: T1
  Description: This task depends on T1 as part of the cycle.
  Acceptance:
    - [ ] Cycle includes T2
  QA:
    - [ ] Validation reports circular dependencies

- [ ] T3. Third circular task

  Agent: reviewer
  Dependencies: T2
  Description: This task depends on T2 and closes the cycle back to T1.
  Acceptance:
    - [ ] Cycle includes T3
  QA:
    - [ ] Invalid example remains rejected
