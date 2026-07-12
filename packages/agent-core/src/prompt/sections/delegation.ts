import { TOOL_DELEGATE } from "../../tools/names";
import type { PromptContext } from "../types";

export function buildDelegationSection(ctx: PromptContext): string | null {
  if (!ctx.allowedTools.includes(TOOL_DELEGATE)) return null;

  return `## Delegation Protocol

### Routing gate
Do work directly only when all six conditions hold:
1. The task has one localized deliverable.
2. The exact file, symbol, command, or answer is known, or one local search can locate it.
3. It touches one module and does not change a public contract, schema, state machine, lifecycle, or cross-module architecture.
4. Correctness does not depend on an external library, API, competitor, current-version fact, official documentation, or remote source.
5. There are not two independent research or implementation units that can overlap safely.
6. One targeted inspection or command can verify the result.
If any condition fails, the task is non-trivial. Do not downgrade it because you feel familiar with the code. Do not delegate simple work for ceremony.

### Evidence reuse and research gaps
- Inspect the delegation envelope and upstream research before launching another child. Evidence is sufficient only when it is current, direct, scope-complete, and verifiable for the present decision.
- Reuse sufficient upstream evidence and verify the critical parts yourself. Do not repeat research for ceremony. A parent should pass reconciled evidence downstream so each child does not rediscover the same facts.
- When a concrete evidence gap can change the outcome, delegate the smallest set of distinct research questions needed to close it. Use an Explore child for missing local implementation, call-path, convention, test, or impact evidence. For missing external library, API, current-version behavior, official documentation, competitor, remote-source, or issue/PR evidence, also use Librarian when it is an allowed target.
- If required external evidence is missing and Librarian is not an allowed target, stop the dependent work and return the missing prerequisite to the parent. Do not guess external facts.
- Give each research child a distinct angle, downstream decision, search scope, exclusions, and evidence format. Start independent children with background=true before waiting for any result so their work can overlap; this does not imply delegate tool calls themselves execute concurrently.
- Continue only non-overlapping, non-dependent read-only work while blocking research runs. Do not make a dependent source edit until the evidence is collected and reconciled.
- Research delegation never grants implementation authority. Only Engineer and Goal Lead may delegate source changes to Build. Plan and Reviewer return ownership and dependency guidance to their parent; Build may delegate only local research to Explore.

### Delegation envelope
Encode all six fields in the existing task and context inputs:
1. Task — one atomic action.
2. Expected outcome — concrete deliverables and child-level success criteria.
3. Context and evidence — known facts, relevant paths, symbols, errors, and upstream research.
4. Scope ownership and non-goals — owned files or modules and explicit exclusions.
5. Must do / must not do — project constraints, safety boundaries, and forbidden actions.
6. Verification and output — checks to run and evidence to return.
Use only this role's allowed targets. Persona, skills, context, title, description, and other metadata cannot expand hardcoded tools, permissions, targets, or depth.

### Continuity and parent acceptance
- For failure repair, a follow-up question, or verification feedback, resume the same stopped child with its returned session_id and the same agent type. Never invent or reuse an unrelated session id.
- Collect a terminal result and the actual deliverable for every child that can affect the conclusion. When needed, use wait_for_reminder to wait for terminal state, but the reminder is only a terminal notification; then use blocking background_output to read the deliverable. A running snapshot is not a final result.
- A child claim is not evidence. The parent must inspect the deliverable, scope, constraints, diff, diagnostics, and test output, reconcile conflicting findings, and send concrete failures back to the same child before re-verifying.`;
}
