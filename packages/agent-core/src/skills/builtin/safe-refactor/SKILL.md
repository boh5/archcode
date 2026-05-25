---
name: safe-refactor
description: Refactor code while preserving behavior through scoped changes and verification.
when_to_use: Use when restructuring or renaming code without changing behavior - variable, function, or type renames, extracting modules, moving files, simplifying logic, or consolidating duplicates.
---

- Identify public contracts first: exported symbols, API signatures, and test surface.
- Trace call sites and dependents before renaming or moving; update all references in one coherent batch.
- Make the smallest transformation that achieves the goal; avoid mixing refactoring with behavior changes.
- Preserve existing error-handling paths and data shapes unless the refactoring goal explicitly requires otherwise.
- Run `lsp_find_references` and `lsp_diagnostics` after each transformation step to catch missed updates.
- When extracting a module, ensure imports in both old and new locations resolve correctly before deleting the original.
- Verify with targeted diagnostics and the most relevant test suite before widening scope.
- If a refactoring step introduces type errors, fix them immediately rather than proceeding with broken intermediate states.