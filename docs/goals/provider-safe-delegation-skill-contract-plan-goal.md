# Provider-safe contextual delegation and Skill contract

Status: proposed
Date: 2026-08-10

## Goal

Make every model-visible `delegate`, `skill_list`, and `skill_read` contract reflect the current Agent's real delegation and Skill capabilities without exposing provider-incompatible validation rules, unbounded Skill catalogs, cross-project state, or a second Skill lifecycle.

The work is complete only when the configured default model can execute the real Discussion, Work, direct Session, and Automation entry paths without Tool Schema rejection, while ArchCode still rejects nonexistent or unauthorized Skills before a child Session is created.

## Current failure and evidence

- `DelegationRequestSchema` reuses `SKILL_NAME_REGEX` in `skills.items`. Zod therefore emits `pattern: "^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$"` into the Provider-facing JSON Schema.
- The configured default Provider rejects the negative lookaround before the first model token with `Invalid JSON schema: regex lookaround is not supported` at `$.properties.skills.items.pattern`.
- The same internal-name rule is exposed by `skill_read.name`.
- `delegate.agent_type`, `profile`, and `skills` are static model contracts, while actual targets, Profiles, and Skill availability depend on the current Agent, delegation depth, execution cwd, target Agent definition, and live Skill sources.
- Runtime admission already validates target Agent, Profile, Skill existence, and reserved builtin policy, but that authoritative state is not projected accurately to the model.
- The current Skill control plane intentionally bounds Prompt projection and continues discovery through digest-bound `skill_list` pages. Copying the complete catalog into a Tool enum would bypass that bound.

## Locked decisions

1. Use bounded discovery plus authoritative local validation. Do not place the complete Skill catalog in a Provider Tool enum.
2. Provider-facing schemas use only portable structural JSON Schema. Skill name format, existence, source precedence, and Agent authorization remain internal runtime validation.
3. Extend `skill_list` with optional `agent_type`. Omitted means the current Agent; provided means one currently allowed direct child target.
4. Project and user non-reserved Skills retain their current visibility policy. Reserved and embedded builtin Skills remain Agent-gated and unshadowable.
5. `skills: []` remains a valid delegation request.
6. Preserve the existing lifecycle split: delegated and lifecycle Skills resolve live on each Execution; only explicit `/skill use` is snapshot-bound within one logical Execution.
7. One factory capability resolver owns current role/depth target and target Profile authorization. Internal Zod schemas own structure and static value domains only; they do not duplicate the authorization matrix.
8. Do not add persisted catalog ids, new Session/Execution fields, a Skill registry/cache, a second activation state machine, or new Skill snapshot semantics.
9. Replace the old model-visible schema path outright. Do not retain fallback schemas, legacy branches, compatibility aliases, or tombstone tests.

## Architecture and ownership

### SkillService

`SkillService` remains the sole owner of Skill source precedence, package validation, catalog construction, diagnostics, digest-bound pagination, and package reads. It receives an Agent definition's allowed builtin names but does not learn delegation policy or import Agent modules.

### AgentFactory and ConfiguredAgent

`AgentFactory` remains the owner of Agent definitions and provides the single narrow capability resolver for current-depth delegate targets, target Profiles, and the target definition used to request a Skill page. Both model projection and `SessionExecutionManager` admission consume this resolver; neither re-encodes the role/depth matrix.

`ConfiguredAgent` builds a fresh model-call-local projection at the existing model boundary. It may replace the model presentation of `delegate` and `skill_list` for that call, but it must not mutate globally registered Tool descriptors. A projected clone preserves the original `execute` implementation and changes presentation fields only.

### Tool descriptors and Registry

Internal `inputSchema` remains the strict ArchCode execution schema. Provider-facing `aiInputSchema` is a distinct presentation contract:

- `delegate.skills` is an array of strings with no name regex or full catalog enum.
- `skill_read.name` is a string with no name regex or full catalog enum.
- `delegate.agent_type` contains only current-depth targets.
- `delegate.profile` exposes only Profiles reachable through those targets; the description gives the exact target-to-Profile mapping.
- `skill_list.agent_type`, when model-visible, contains only current-depth targets and is optional.

`ToolRegistry` stays domain-neutral. It converts run-local descriptors to AI tools and does not depend on SkillService, AgentFactory, or delegation policy. Target-aware `skill_list` execution obtains a narrow capability resolver from reconstructible execution context, not from a temporary descriptor closure; normal execution and interrupted Tool Batch recovery therefore use the same authorization semantics even when the scheduler resolves the global descriptor.

### SessionExecutionManager

`SessionExecutionManager` remains the only child-execution admission owner. It reconstructs the capability resolver from persisted Session Agent/depth/cwd for normal execution and recovery, then immediately before child creation revalidates the target, Profile, and every requested Skill. `DelegationRequestSchema` validates only strict object structure, static value domains, Skill name format, and unknown fields. A rejected request creates no child Session, child link, or active execution.

### Required flow

```text
model-call boundary
  -> AgentFactory resolves current-depth targets and target Profiles
  -> ConfiguredAgent creates run-local delegate/skill_list presentation
  -> model optionally calls skill_list({ agent_type, cursor })
  -> SkillService returns one digest-bound target catalog page
  -> model copies exact returned names into delegate.skills
  -> SessionExecutionManager revalidates target/Profile/Skills
  -> child Session is created only after admission succeeds
```

## Implementation plan

1. **Hard-cut the Provider schema boundary**
   - Stop using the strict delegation and Skill-read Zod schemas directly as their model-visible schemas.
   - Add explicit portable Provider-facing schemas for `delegate` and `skill_read`; retain strict internal parsing and typed runtime errors.
   - Test the actual `ResolvedToolSet.toAITools()` output for `delegate`, `skill_read`, and `skill_list` across every Agent and delegation-depth boundary, proving no Skill name `pattern`, lookaround, transform, or internal refinement leaks to the Provider.

2. **Project current delegation capabilities per model call**
   - Add a narrow factory-owned resolver for current-depth direct targets and each target's permitted Profiles.
   - At `ConfiguredAgent.resolveModelTools`, clone only the affected run-local descriptors and attach contextual descriptions/schemas. Never mutate Registry descriptors or cache a project-specific projection globally.
   - Remove `delegate` at the existing depth boundary as today; when visible, its target enum must equal the runtime target set exactly.
   - Remove the target/Profile relationship refinement from `DelegationRequestSchema`; model projection and runtime admission must obtain that authorization from the factory resolver only.

3. **Add target-aware bounded Skill discovery**
   - Extend `skill_list` input with optional `agent_type` and keep `cursor` pagination.
   - Omitted target uses the current Agent definition. A provided target must be an allowed direct child at the current depth; otherwise return a stable typed error without reading an unauthorized catalog.
   - Agents with no current-depth targets receive a model-facing `skill_list` schema with no `agent_type` property; do not emit an empty enum. The strict internal schema still rejects unknown fields and invalid static target values.
   - Resolve target pages through the existing SkillService catalog and target definition builtin allow-list. Preserve five-tier precedence, invalid-winner isolation, reserved builtin policy, page limits, and stale-digest cursor behavior.
   - Keep target authorization in a narrow execution-context resolver that can be reconstructed from Session Agent/depth/cwd. Descriptor clones change presentation only and must not capture target policy in `execute` closures.
   - Update Tool descriptions to distinguish the two flows: names from `skill_list({})` may be opened by the current Agent with `skill_read`; names from `skill_list({ agent_type })` are for exact copying into `delegate.skills` and do not grant the parent Agent read access. Remove any `skill_read` wording that implies arbitrary target-page names are readable, and state that invented or stale names are rejected during delegation admission.

4. **Keep admission authoritative and side-effect free on rejection**
   - Reuse one target/Skill resolution path for delegation admission; do not introduce a second validator that can drift from Skill discovery.
   - Preserve deduplication order and empty arrays. Reject invalid name syntax, missing winners, invalid winning packages, disallowed reserved builtins, invalid target Profiles, and targets outside the current role/depth matrix.
   - Hard-cut known failures to this code matrix: malformed/unknown input `TOOL_SCHEMA_INVALID_INPUT`; forbidden `skill_list` target `TOOL_SKILL_TARGET_NOT_ALLOWED`; stale cursor `TOOL_SKILL_CATALOG_CHANGED`; forbidden delegate target `TOOL_DELEGATE_TARGET_NOT_ALLOWED`; target/Profile mismatch `TOOL_DELEGATE_PROFILE_NOT_ALLOWED`; missing Skill `TOOL_DELEGATE_SKILL_NOT_FOUND`; invalid winning package `TOOL_DELEGATE_SKILL_INVALID`; disallowed reserved Skill `TOOL_DELEGATE_SKILL_NOT_ALLOWED`. `TOOL_DELEGATE_FAILED` may represent only an unclassified internal execution failure, never a known admission rejection.
   - Prove all rejection paths occur before child Session creation and persistence.

5. **Update active contracts and tests**
   - Update model-visible contract tests, Agent/factory tests, Skill tool tests, SessionExecutionManager tests, and active architecture documentation. Historical `docs/**` records remain unchanged except this Goal and any explicitly active architecture document.
   - Add an interrupted Tool Batch recovery test proving `skill_list({ agent_type })` reconstructs the same current-role/depth authorization and never falls back to an unscoped catalog.
   - Add cross-project concurrency coverage proving two simultaneous projects expose isolated Prompt catalogs and `skill_list` results while the same Agent/depth has identical Skill-name-free Tool presentation and unchanged global descriptors.
   - Do not add compatibility code or tests whose only purpose is asserting that an old schema is dead.

6. **Run automated and real-product acceptance**
   - Run targeted tests while iterating, then repository `typecheck`, full `test`, `build`, and `git diff --check` in prescribed order.
   - Rebuild and launch the isolated QA Worktree, reuse an isolated project fixture, and execute the configured default model through all real browser lanes defined below.

## Acceptance criteria

### AC-01: Provider Tool schemas are valid and portable

- Actual `ResolvedToolSet.toAITools()` output for `delegate`, `skill_read`, and `skill_list`, across every Agent and delegation-depth boundary, contains no Skill name `pattern` and no regex lookaround.
- Their internal schemas still reject malformed Skill names and unknown fields.
- Agents with no current-depth targets still receive `skill_list`, but its model-facing schema omits `agent_type` rather than emitting an empty enum. The internal schema rejects unknown fields and values outside the static Agent domain; the contextual resolver rejects a statically valid but currently unauthorized target with `TOOL_SKILL_TARGET_NOT_ALLOWED`.
- A real configured-default-model call reaches model execution without `Invalid JSON schema`, `lookaround is not supported`, or any Tool Schema finalization error.

### AC-02: the model sees the exact current delegation matrix

- Lead sees Analyst, Build, Explore, and Librarian; Discussion and Analyst see Explore and Librarian; Build sees Explore; Explore and Librarian do not receive `delegate`.
- Depth exhaustion removes delegation rather than advertising unusable targets.
- Model-visible Profile guidance exactly matches the selected target rules, and runtime rejects a mismatched Profile before child creation.

### AC-03: Skill discovery is target-aware, bounded, and current

- `skill_list({})` returns the current Agent's digest-bound first page.
- `skill_list({ agent_type })` returns the selected allowed target's catalog using that target's builtin allow-list and the existing project/user visibility rules.
- Names returned by `skill_list({})` remain readable by the current Agent through `skill_read`. A target page is delegation discovery only: its names may be copied exactly into `delegate.skills`, but it neither grants nor implies parent-Agent `skill_read` access; model-visible descriptions state this distinction. A target-only reserved-builtin test proves the parent read is rejected while admissible delegation succeeds.
- Pagination respects existing item/byte limits; a changed catalog invalidates an old cursor with `TOOL_SKILL_CATALOG_CHANGED`.
- Neither Prompt projection nor any Provider Tool schema contains an unbounded full Skill catalog. Existing 7,999/8,000/8,001-byte Prompt boundary tests remain green.

### AC-04: nonexistent or unauthorized Skills cannot create a child

- A valid discovered Skill creates a child with the requested deduplicated Skill names in stable order.
- Every known rejection returns the exact code locked in the implementation plan; `delegate` does not collapse those cases into `TOOL_DELEGATE_FAILED`.
- For every rejection, no child Session file, child link, child slot, active execution, or durable delegation identity is created.
- `skills: []` still creates a valid child when the remaining request is admissible.

### AC-05: model projections are isolated and non-persistent

- Two concurrent projects with different custom Skills receive the correct isolated Prompt catalogs and `skill_list` pages without cross-project leakage.
- For the same Agent/depth, their model-visible Tool presentation is byte-identical and contains no project or user Skill names; target/Profile presentation may differ only when Agent/depth capabilities differ.
- Global registered descriptors are unchanged before and after model projection.
- No new Skill catalog, descriptor copy, target matrix, or Provider schema is persisted in Session or Execution records.

### AC-06: existing Skill and delegation lifecycle semantics are preserved

- A delegated child persists Skill names only. Each later Execution or resume resolves the current winning package; deletion or an invalid new winner fails closed without lower-precedence fallback.
- Lifecycle Skills are derived from current authoritative Session/Todo/Goal state on every Execution.
- Explicit `/skill use` alone remains snapshot-bound within one logical Execution: an in-process resume reuses the captured snapshot, while process-restart recovery reconstructs it from the persisted source/digest and fails closed if revalidation detects a change.
- Five-tier precedence, invalid/shadowed diagnostics, reserved builtin behavior, progressive resource reads, and durable delegated Agent/Profile/Skill-name/title/objective/background identity retain their existing tests and behavior. No new snapshot, fallback, or migration path exists.

### AC-07: automated and real browser gates pass

- `bun run typecheck`, `bun run test`, `bun run build`, and `git diff --check` all pass with zero failures.
- Using the configured default model in the isolated QA project:
- For each Discussion, Todo Work, direct Session, and Automation-created Session lane, the latest Execution status is exactly `completed`, the final assistant output is nonempty, and no execution error is recorded; `failed`, `cancelled`, `aborted`, `timed_out`, `max_steps`, or merely “terminal” do not pass.
- The direct Session completes one read-only file Tool task and displays both its finalized Tool result and final response.
- The manual Automation invocation status is exactly `dispatched`; its linked generated Session meets the same `completed`/nonempty/no-error conditions, and the invocation-to-Session link remains visible after refresh.
- Browser console errors are zero for these lanes, and Session/Automation terminal state survives a full service restart.
- If the configured default Provider is unavailable, acceptance remains `NOT_DONE`; another Provider cannot substitute for the default-model gate.

## Non-goals

- No Agent-level configuration UI or new permission system for custom Skills.
- No full Skill catalog enum, conditional `oneOf`/`if`/`then` schema, opaque Skill handle protocol, or extra discovery state persisted in an Execution.
- No change to Skill package format, source precedence, installation, enable/disable behavior, resource disclosure, or automatic script execution.
- No change to child concurrency, depth, cancellation, resume, Tool finalization, MCP projection, Goal, Todo, or Automation lifecycle ownership.
- No unrelated UI redesign or prototype work.

## Risks and controls

- **Provider dialect drift:** keep Provider schemas to portable structural fields and require a real default-model gate, not only Zod snapshot tests.
- **Model invents a name despite instructions:** runtime admission remains authoritative and side-effect free; the Tool result tells the model to refresh target discovery.
- **Catalog changes between listing and delegation:** admission resolves the current winner; stale or removed names fail explicitly. No old package fallback or silent rebinding contract is added.
- **Cross-project leakage from contextual schemas:** use model-call-local descriptor clones only and add concurrent isolation tests.
- **Coupling Tool Registry to Agent/Skill policy:** pass a narrow contextual projection into `ConfiguredAgent`; keep Registry and SkillService unaware of each other's domain policy.
- **Schema or catalog context growth:** preserve Prompt and page byte limits and never enumerate the full catalog in model-visible schemas.

## Definition of done

This Goal is complete only when AC-01 through AC-07 all have code, automated-test evidence, and the required real-browser evidence; the default-model blocker is no longer reproducible; no acceptance item is waived; and an independent final review reports no blocking or material architecture finding.
