---
name: plan-work
description: Research, create, or improve the evidence-backed Markdown implementation Plan for a task or bound Project Todo when uncertainty, sequencing, risk, or a user request warrants one.
license: MIT
metadata:
  archcode/source: "Superpowers writing-plans concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

## Establish the planning target

1. In a Todo Discussion, derive identity only from the current Session binding. Use exactly the runtime-provided `todoPlanPath` and `todoPlanState`; never accept another Todo ID or path and never scan the workspace to discover Plan existence.
2. Start from the bound Todo or current request, then inspect the smallest relevant implementation, tests, conventions, constraints, and existing Plan identified by authoritative context. Use Explore or Librarian only for separable evidence questions. Do not ask the user for facts available from the request, repository, Plan, or tool output.
3. After investigation, ask one focused question only when an unresolved product or scope choice materially affects the objective, dependencies, acceptance, or validation and evidence cannot decide it. Do not infer the user's preference.
4. Outside a Todo Discussion, use a safe direct child of `.archcode/plans/` named for the current task unless the user explicitly requests another deliverable path.
5. When the target exists, read it before editing or producing an improved draft and preserve confirmed user content. When a Discussion reports `todoPlanState=absent`, create only the exact supplied path when the current Agent has write authority. Maintain one Plan, never a replacement or parallel variant.

Lead and Discussion may write the Plan through their available file tools. Analyst is source-read-only: when this Skill is delegated to an Analyst, produce a complete evidence-backed Plan draft for the parent Lead, do not create or edit the Plan file, and do not claim it was saved.

## Design executable work

- Start with the claim the implementation must establish. Identify likely failure modes and choose the smallest credible evidence for each acceptance condition before writing implementation steps.
- Map the relevant files, symbols, interfaces, and existing tests. State what each affected unit is responsible for and follow established architecture rather than planning an unrelated cleanup.
- Divide work into ordered, independently checkable deliverables. Each step must state the concrete change, relevant location, prerequisites or produced interface, and verification. Split only at real dependency or review boundaries; keep tightly coupled changes together.
- Mark which steps may run independently and why. Never prescribe parallel mutation where files, contracts, state, fixtures, or validation resources overlap.
- Prefer the smallest root-cause change. Include migrations, compatibility, cleanup, rollback, documentation, or observability only when the requested outcome actually needs them.

## Discover, then converge

- Use a short discovery pass to collect only decision-relevant evidence: the bound Todo/request, current mechanism, affected symbols, existing tests, constraints, and failure signals. Stop investigating once every issue and acceptance condition has enough evidence; do not turn the Plan into a research diary or repeat the Todo, source text, or tool output.
- Use a separate convergence pass before writing: choose one implementable direction, map every in-scope issue to an acceptance condition, and fill owner/interface, order/dependency, risk/control, and deterministic verification. Remove rejected options and findings that do not change a decision.
- Treat context and output budget as scarce. Default to the shortest complete Plan that lets another Agent implement and verify the work; spend detail on decisions, interfaces, edge paths, and commands rather than background or speculative code. The 12,000-Unicode-character figure is only the controlled regression ceiling for the current Plan incident fixture, never a product rejection threshold or a global guarantee for other Providers or Plans.
- When the governing request sets a document budget, treat it as a deliverable acceptance condition: allocate the budget across the seven required content classes before drafting, then tighten the draft before its sole write. If exact counting is unavailable, draft to at most one third of the stated budget so normal estimation error cannot cross the limit. A complete Plan within budget takes priority over prose polish. Do not rely on a later rewrite, a runtime validator, or a second file write. For the controlled 12,000-character incident fixture, keep goal/design near 900 characters, implementation rows near 3,000 total, dependencies near 500, acceptance rows near 2,500 total, and risks/reporting near 1,100; never exceed 12,000.
- State each fact once. Put ownership and change detail in the implementation step, dependencies only in the dependency section, decisive outcomes only in the acceptance table, and cross-reference step or issue IDs instead of restating the same mechanism. Prefer compact tables and semicolon-separated clauses where they preserve meaning.
- For a task with several issues, use one implementation row and one acceptance row per issue. Keep each table cell to one sentence or compact clause. The acceptance row adds only starting state, action, pass/fail boundary, and decisive evidence; it references the implementation ID instead of repeating design, exclusions, or failure controls.
- Research may be delegated for separable evidence, but exactly one Lead or Discussion must perform the convergence and one final atomic write of the single Plan file. Do not stream fragments, create sidecar Plans, or use parallel writers.

## Required Plan content

Use [assets/plan-template.md](assets/plan-template.md) as the complete structure, adapting it to the task rather than retaining placeholders.

Produce ordinary Markdown with these seven content classes:

1. goal and evidence-backed background;
2. scope and explicit non-goals;
3. ordered implementation steps with concrete files or symbols where known;
4. dependencies, produced/consumed interfaces, and safe parallel boundaries;
5. observable acceptance criteria;
6. validation methods, expected signals, and relevant failure cases;
7. risks, assumptions, and decisions still requiring confirmation.

Use enough implementation detail that another Lead or Build can act without rediscovering the design, but do not paste large speculative code blocks or repeat the complete Todo/evidence. Never leave placeholders or unresolved choices such as “TODO,” “TBD,” “handle appropriately,” “add tests,” or “as needed.” For each acceptance criterion, name how it will be judged and distinguish decisive evidence from weaker supporting checks. Every section must earn its space by supporting an implementation decision or deterministic acceptance check.

Before the sole final write, perform a no-write compression review: remove duplicated facts, narrative transitions, repeated commands, and acceptance prose already represented by an issue/step ID. If the request has an explicit character budget, estimate the final Unicode characters and do not write until the Plan fits while retaining all seven content classes. Use the compact matrix in the template; expanding every step into repeated mini-sections is a planning defect unless the request explicitly requires that format. The final Plan write is the last Plan-related Tool action: do not write an oversized draft and then read, count, or edit it.

## Self-review and handoff

Before finalizing:

1. Trace every requirement and non-goal to at least one step or explicit exclusion.
2. Check that step order, paths, symbols, and produced/consumed interfaces agree across the Plan.
3. Check that each material behavior and failure mode has proportionate verification and that the stated commands or inspections actually exist in this repository.
4. Remove unjustified machinery and resolve all execution-blocking unknowns. If a material choice remains open, ask the user and revise the Plan before calling it executable.

Do not create Plan IDs, sidecar metadata, status, versions, approvals, locks, snapshots, services, APIs, Goal links, file watchers, or progress mirrors. In a Discussion, stop after shaping the Todo and Plan and report the saved path, key decisions, remaining risks, and readiness for a new ordinary Lead Session. In an Analyst Session, return the proposed Plan and evidence to the parent without claiming a file mutation. Do not begin product implementation. In an ordinary Lead Session, the Plan remains guidance rather than workflow state.
