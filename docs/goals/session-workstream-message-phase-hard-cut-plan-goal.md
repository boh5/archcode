# Session Workstream Message Phase Hard-Cut Plan Goal

Status: Implemented, verified, and independently approved by `sol(max)`.

## Goal

Render each Session in the model's actual order:

```text
User message
  Work
    commentary
    tool
    commentary
    tool
    reasoning
    ...
Final answer
```

Runtime owns attempt identity and Assistant phase, Protocol persists them, and
Web only projects ordered items. One Execution may contain several canonical
UserMessages, but each starts its own Work Segment.

This is a hard cut. There will be no legacy reader, migration, dual write,
fallback, feature flag, or tombstone test.

## Evidence and Root Cause

Session `32cd3196-8d21-4ff6-8aa7-efae37c9fcdc` already persists:

1. commentary, then `git_status`;
2. commentary, then `file_read`;
3. commentary, then `file_read`;
4. terminal Assistant text.

Its steps report Reasoning usage `137`, `56`, `0`, `0`, with no Reasoning text.
Web changes that meaning:

- `execution-workstream.ts` moves every Assistant text part to
  `outputMessages` and every non-text part to `workMessages`;
- `ExecutionWorkstream.tsx` renders all Work before all output;
- `tool-runs.ts` correctly treats text/Reasoning as hard boundaries, but the
  upstream split has already removed commentary;
- Web sums all step Reasoning usage into one Execution-level placeholder;
- `consumeFullStream()` ignores actual text/reasoning block start/end IDs and
  synthesizes channel-wide blocks.

The defects are missing authoritative phase/attempt identity, Web
type-bucketing, and lost stream block boundaries. A dedicated Assistant output
part is a hard-cut type-safety choice, not the root cause.

## Codex Reference and Boundary

Reference snapshot: open-source Codex commit
`e597169e9a783156e50ae9765d891a3dd74df064`.

Codex models a Turn as ordered heterogeneous items. AgentMessage is distinct
from UserMessage, Reasoning, and tools and carries Commentary/FinalAnswer phase.
A Turn may contain several UserMessages after steering. ArchCode maps one
Execution to Turn and keeps Work Segment as a Web-only boundary.

We adopt ordered items and explicit normalized phase. We do not rewrite all
Session storage into Codex's Rust protocol or claim parity with non-public
desktop rendering code.

This plan supersedes only the Assistant-output classification, adjacent input
batching, and AC-07 display clauses in
`docs/goals/session-logical-execution-hard-cut-plan-goal.md`. Its Execution,
suspension, recovery, and duration ownership remain authoritative; its progress
file remains historical.

## Target Architecture

The contracts below are locked: one UserMessage per Segment, one parent
Execution, ordered commentary/reasoning/tools inside Work, normalized final
below Work, per-attempt Reasoning, and no Segment for HITL/tool answers.

### 1. One identity owner per concept

`SessionStep.id` becomes the unique model-attempt identity. The existing numeric
`step` remains the logical step cursor and is not unique across provider retries.

A strict model-step Assistant message owns attempt identity and normalized output
phase:

```ts
interface ModelStepAssistantMessage {
  role: "assistant";
  stepId: string;
  outputPhase: "commentary" | "final_answer";
  parts: ModelStepPart[];
  // existing message identity, Execution/run ownership, and timestamps
}

interface AssistantOutputPart {
  type: "assistant-output";
  blockId: string;
  text: string;
  // existing id, timestamps, and partial-output metadata
}

interface ReasoningPart {
  type: "reasoning";
  blockId: string;
  text: string;
  // existing id, timestamps, and partial-output metadata
}
```

The exact TypeScript names may follow repository conventions, but ownership is
fixed:

- step identity and phase live once on the parent model-step message;
- output and Reasoning parts inherit step/phase from that parent and persist
  only provider block identity;
- user text remains `TextPart`; model output uses the dedicated part;
- completed `SessionStep.usage` is normalized once in Protocol/store, not
  exposed to Web as provider-shaped `unknown`;
- `step-start`, `step-end`, and stream events carry the required `stepId` needed
  to address the parent; event routing data is not duplicated into child parts.

A model-step message is created at `step-start`, including zero-visible-output
attempts. Empty anchors do not enter model context, render blank messages, or
increment content-bearing Assistant message statistics.

Provider `blockId` is unique only within `(stepId, channel)` where channel is
Assistant output or Reasoning. Reducers address blocks by that composite key.

### 2. Attempt and phase state machine

Every provider attempt gets a fresh `stepId`, including retries of the same
numeric `step`:

1. QueryLoop allocates `stepId`, appends `step-start`, and opens one model-step
   message with `outputPhase: "commentary"`.
2. Stream blocks attach only to it. Failed partial output closes as
   interrupted/discarded commentary; retry opens a separate attempt/message.
3. `tool-calls` attempts remain commentary.
4. Only `finishReason: "stop"` with trusted non-empty output is a candidate.
   Todo continuation or another run may still occur in the same Execution.
5. ConfiguredAgent returns that `stepId` only after it decides no continuation
   remains. Empty `stop`, `length`, `content-filter`, `error`, and `other`
   attempts return no final candidate.
6. SessionExecutionManager commits
   `execution-end { terminalStatus: "completed", finalOutputStepId }`.
7. The reducer atomically promotes that attempt's message to `final_answer`.

`finalOutputStepId` is optional because completed tool-only, empty-output, or
non-final-finish Executions may have no final text. It is forbidden on every
non-completed terminal event.

Before append, a store-level validator—not the executions-only lifecycle
validator—must verify that `finalOutputStepId`:

- belongs to the same current Execution and run history;
- is the last completed successful attempt;
- has exactly `finishReason: "stop"` (`length`, `content-filter`, `tool-calls`,
  `error`, and `other` are not final-eligible);
- owns at least one completed, non-empty Assistant output block;
- owns no output selected as final that is interrupted or discarded.

Validation failure rejects the entire `execution-end` without state mutation.
Duplicate terminal comparison includes `finalOutputStepId`; same payload is
idempotent, a different value is invalid.

Uncommitted final-looking text remains in current Work until the terminal
commit, then moves below Work once. This correctness rule prevents a Todo
continuation's intermediate stop attempt from appearing final.

### 3. Exact stream blocks

Replace synthetic channel-wide streaming:

- output/reasoning start, delta, and end require `stepId` plus provider
  `blockId`;
- the adapter owns one sensitive-text redactor per open composite block;
- reducers update the addressed block, never “latest incomplete part by type”;
- duplicate start, unknown delta/end, cross-step address, and
  delta-before-start are invalid; there is no implicit-start fallback;
- in-process stream error/abort cleanup retains partial data as
  interrupted/discarded commentary; a provider retry uses a new attempt;
- process restart marks the open attempt interrupted/discarded and terminalizes
  its Execution as interrupted. Any later re-execution is a new Execution with
  new attempts; restart never auto-retries the old Execution.

This preserves, for example,
`Reasoning A -> commentary -> Reasoning B -> tool` as four ordered items.

### 4. Ordered Web projection

Replace input batches and Work/output buckets:

- Segment owns `inputMessage?`, ordered `workItems`, and optional
  `finalResponse`; remove `inputMessages` batching, `outputMessages`, and
  Execution-level `reasoningTokens`;
- each canonical UserMessage starts a Segment; adjacent messages still receive
  separate disclosures, including empty/zero-duration Work;
- leading Work uses one stable implicit Segment;
- commentary messages, Reasoning, tools, control/child items, and notices append
  to Work in message/part order;
- only `outputPhase: "final_answer"` output is excluded from Work and rendered
  once after the last Segment disclosure.

Tool Run aggregation consumes ordered Work items. Commentary, Reasoning,
control/non-ordinary tools, and Segment boundaries flush a run; only contiguous
ordinary tools may group.

Navigation flattens Segments, while Inspector keeps one parent Execution.
Marker count equals canonical UserMessage count, plus one only for an input-less
implicit Segment.

### 5. Step-scoped Reasoning

Web joins a model-step message with its exact normalized `SessionStep`:

- non-empty Reasoning blocks render independently in position;
- an attempt with tokens but no text gets one
  “Reasoning · N tokens · text unavailable” item at its Work start;
- `137` and `56` render separately, never `193`; zero tokens or real Reasoning
  text create no placeholder;
- aggregate usage remains statistics only.

### 6. SessionPart consumer audit

Changing Assistant `text` to `assistant-output` requires an explicit audit, not
only typecheck:

| Consumer | Required outcome |
| --- | --- |
| `store/projection.ts` and full-history/model projection | Same Assistant text/order reaches the model; phase/block metadata does not enter prompts. |
| `delegation/final-output.ts` | Synchronous child returns the normalized final output, never empty commentary. |
| `background-output.ts` | Background reads expose the same final/partial semantics and text. |
| QueryLoop durable-output/discard detection | Retry decisions see new output blocks and never treat discarded output as final. |
| `session-store-manager.ts` recovery | Open blocks become interrupted/discarded commentary and the old Execution terminates interrupted; no same-Execution restart retry. |
| Compression protect tags and original-range rendering | Assistant output remains protected/projected with unchanged text and order. |
| Web Navigation and CompressionBlock summaries | Summaries consume ordered visible output without restoring type buckets. |

Every row needs a positive behavior test. Search all exhaustive `SessionPart`
switches and text-part filters; do not add a compatibility adapter.

## Implementation Plan

1. **Protocol/store:** add attempt IDs, strict model-step messages,
   message-level phase, block IDs, normalized usage, `finalOutputStepId`,
   composite block addressing, and store-level terminal validation.
2. **Runtime:** allocate a new ID per provider attempt and propagate only the
   final no-continuation candidate through QueryLoop, ConfiguredAgent, and
   SessionExecutionManager without changing suspension/tool/Todo semantics.
3. **Consumers:** migrate the audit matrix and all exhaustive switches; preserve
   model context, compression, delegation, background output, recovery, and
   durable-output behavior with positive tests.
4. **Web:** replace message batches and Work/output buckets with one-message
   Segments and ordered Work; resolve final from phase and Reasoning per attempt.
5. **Docs/tests:** rewrite tests encoding old behavior; update
   `docs/concepts.md`, `docs/web/architecture.md`, and mark only the earlier
   goal's display clauses superseded. Historical progress stays unchanged.

## Non-Goals

No changes to Execution admission/suspension/Stop/duration, no Execution per
UserMessage, no full Codex protocol rewrite, no phase-from-prose or
provider-specific phase branch, no invented Reasoning, no old-file migration,
and no Work/ToolCard visual redesign.

## Risks

- **Old files become invalid:** move the affected Session runtime directory
  aside before fresh QA; production must not delete or migrate it.
- **Phase changes at terminal commit:** projection identity must prevent stale
  or duplicate final output.
- **Malformed provider blocks:** use existing stream failure/recovery; never
  merge or guess.
- **Empty attempt anchors:** exclude them from prompts, blank UI, and message
  counts except valid step Reasoning usage.
- **More Segments:** cover empty/zero-duration disclosures and navigation.

## Acceptance Criteria

### AC-01: Attempt identity and phase are authoritative

- Every provider attempt, including retry of the same numeric step, has a unique
  `SessionStep.id` and exactly one model-step Assistant message.
- Failed partial attempt and successful retry persist as separate messages; only
  the successful final attempt can be promoted.
- Step/phase occur once on the parent message; child output/Reasoning parts do
  not duplicate them.
- Every final response is backed by persisted `outputPhase: "final_answer"`;
  Web has no last-message, finish-reason, or text heuristic.
- Empty attempt anchors produce no blank message, prompt content, or Assistant
  message-count increment.

### AC-02: Terminal validation is atomic

- `tool-calls -> tool -> stop -> completed` promotes only the exact stop attempt.
- A stop followed by Todo continuation remains commentary; only the last
  no-continuation attempt is promoted.
- Suspend/resume preserves distinct attempts and promotes at most one.
- Trusted non-empty `stop` is final-eligible; empty `stop` completes normally
  without `finalOutputStepId`.
- `length`, `content-filter`, `tool-calls`, `error`, and `other` never carry
  `finalOutputStepId`; their existing Execution terminal classification remains
  unchanged by this display goal.
- Completed tool-only Execution has no final output.
- Invalid cross-Execution, non-last, tool-call, interrupted, discarded, empty,
  or non-completed `finalOutputStepId` rejects the whole event.
- Duplicate `execution-end` is idempotent only when `finalOutputStepId` also
  matches.

### AC-03: Stream and recovery order are lossless

- `Reasoning A -> commentary A -> Reasoning B -> tool -> commentary B` reloads
  in that exact order with two Reasoning blocks.
- Deltas update only their `(stepId, channel, blockId)` block.
- Positive tests cover multiple blocks, in-process retry, stream error, abort,
  open-block process restart, and recovery.
- In-process retry uses a new attempt and only it may become final.
- Process restart marks old open blocks interrupted/discarded, terminalizes the
  old Execution as interrupted, and creates no recovery attempt in it. A later
  new Execution cannot promote the old output.
- Production code contains no implicit start or latest-incomplete-block fallback
  for output/Reasoning streams.

### AC-04: UserMessage and Work boundaries are exact

- Three canonical UserMessages in one Execution produce exactly three
  input-backed Segments, disclosures, and navigation markers.
- Adjacent UserMessages still produce separate Segments; an empty Segment may
  show zero duration.
- Steer starts a Segment in the same Execution.
- AskUser/Permission answers and tool results create none.
- Leading Work without canonical input creates exactly one implicit Segment.

### AC-05: Commentary, tools, and Reasoning render correctly

- The reported reproduction renders inside Work as
  `commentary -> git_status -> commentary -> file_read -> commentary ->
  file_read`; final output appears once below Work.
- Commentary and Reasoning break ordinary Tool Run aggregation.
- Attempts with token-only Reasoning `137`, `56`, `0`, `0` render exactly two
  items labeled `137` and `56`; no `193` item exists.
- Multiple real Reasoning blocks remain distinct; a real block does not also
  receive a token-only placeholder.
- SSE, refresh, and cold load preserve identical order and phase.

### AC-06: All consumers retain positive behavior

- Every SessionPart audit row has a targeted positive test.
- Synchronous delegation returns non-empty final text; background output returns
  the correct final/partial text.
- Model/full-history projection receives unchanged Assistant text/order without
  phase or block metadata in prompt content.
- Compression protect tags, original ranges, Navigation, and CompressionBlock
  summaries preserve correct output.
- Durable-output retry and restart repair never promote discarded content.

### AC-07: Hard cut is complete

- Production code contains no `outputMessages`, adjacent input batching,
  synthetic provider blocks, implicit output/reasoning starts, legacy phase
  inference, compatibility reader, migration, dual write, feature flag, or
  old-schema fallback.
- Old-shape tests are deleted or rewritten as current positive behavior.
- No legacy-rejection, migration, compatibility, or other tombstone test is
  added.
- Active concepts and Web architecture docs do not contradict this goal.

### AC-08: Verification and independent review

- Targeted Protocol/store, QueryLoop, persistence/recovery, consumer-audit,
  Workstream, Tool Run, and interaction tests pass.
- `bun run typecheck`, `bun run test`, `bun run build`, and
  `git diff --check` exit `0`.
- Fresh desktop and 390px browser QA covers the reported pattern, token-only and
  real Reasoning, adjacent UserMessages, Steer, Todo continuation,
  suspend/resume, failure, refresh, and cold load.
- QA shows no duplicate final, blank attempt message, order drift, horizontal
  overflow, or new console error.
- A fresh independent `sol(xhigh|max)` implementation review finds no
  blocking/high issue. Any blocking/high finding is fixed and the full review
  repeats.
