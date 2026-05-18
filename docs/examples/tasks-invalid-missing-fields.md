# TASKS

- [ ] T1. Missing required QA field

  Agent: builder
  Dependencies: none
  Description: This task intentionally omits the QA field to demonstrate invalid TASKS.md format.
  Acceptance:
    - [ ] Parser reports a missing required field

- [ ] T2. Missing required description field

  Agent: reviewer
  Dependencies: T1
  Acceptance:
    - [ ] Parser reports another missing required field
  QA:
    - [ ] Invalid example remains rejected
