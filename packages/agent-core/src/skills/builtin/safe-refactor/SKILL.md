---
name: safe-refactor
description: Refactor code while preserving behavior through scoped changes and verification.
---

Use this skill when changing structure without intending behavior changes.

- First identify public contracts, tests, and call sites.
- Make the smallest coherent transformation, then update affected references.
- Preserve existing error behavior and data shapes unless the goal requires otherwise.
- Verify with targeted diagnostics and tests before widening scope.
