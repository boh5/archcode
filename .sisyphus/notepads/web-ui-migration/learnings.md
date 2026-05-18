# Learnings - web-ui-migration

## 2026-05-18 Session Start

### Completed Work (from git log)
- W1 (M1-M9): Per-project context + manager refactor - ALL DONE
  - ProjectContext types, ProjectContextResolver, ToolExecutionContext.projectContext
  - register-tools.ts rewritten (no process.cwd)
  - main.ts rewritten (server boot stub)
  - process.cwd fallback fixes
  - ProjectRegistry CRUD
  - Session-per-project storage
  - createSpecraRuntime multi-project API
- W2 (S1-S5): Hono server foundation - DONE
  - S1: Hono app skeleton + auth + error handling + port selection
  - S2: ProjectRegistry REST endpoints
  - S3: Session REST endpoints
  - S4: Message POST + AgentRunner
  - S5: SSE event stream + ring buffer + Last-Event-ID replay

### Architecture Notes
- Server code in `src/server/` (app.ts, boot.ts, listen.ts, errors.ts, error-handler.ts, logger.ts, agent-runner.ts, event-ring.ts)
- Routes in `src/server/routes/` (projects.ts, sessions.ts, messages.ts, events.ts)
- Project code in `src/projects/` (types.ts, context-resolver.ts, registry.ts)
- All 2201 tests pass, typecheck clean
- Branch: `web-ui-migration`

### Key Patterns
- Server errors use `ServerError` subclasses with `{ error: { code, message, details? } }` envelope
- SSE uses `streamSSE` with monotonic IDs from `EventRing.push()`
- AgentRunner manages per-session agent execution with abort support
- ProjectContextResolver lazy-loads managers per workspaceRoot
## 2026-05-18 W2.S6 PermissionService
- Implemented server-side PermissionService Deferred pattern for confirmPermission, emitting permission.request SSE events through EventRing and resolving via POST /api/permissions/:id.
- AgentRunner now receives PermissionService, ensures a per-session EventRing exists, and passes confirmPermission through AgentRunOptions so ToolExecutionContext can bridge permission prompts over REST/SSE.
- Permission route follows server error envelope by throwing BadRequestError for invalid/missing responses or already-resolved permission ids.

## 2026-05-18 W2.S7 AskUserService
- Implemented AskUserService Deferred bridge for ask_user, emitting question.request SSE events with serialized AskUserRequest data and resolving via POST /api/questions/:id.
- AgentRunner now injects askUser alongside confirmPermission, stripping request.abortSignal before service serialization and passing the signal separately for cancellation.
- Questions route validates either answers: string[][] or { isError: true, reason } and returns QUESTION_NOT_FOUND with 404 for unknown question IDs.

## 2026-05-18 W2.S8 Command endpoints
- Added project/session-scoped POST /api/projects/:slug/sessions/:sessionId/commands route that validates strict { name, args? } requests, resolves project/session state, and delegates to AgentRunner without embedding command business logic.
- ConfiguredAgent now exposes dispatchCommand(name, args?) over its private CommandRegistry; unknown commands return CommandResult failure instead of server errors.
- AgentRunner tracks live agent instances only while jobs run and dispatches commands only for running ConfiguredAgent sessions, returning null for absent/non-configured agents.
- Validated with lsp_diagnostics, bun test src/server/routes/commands.test.ts, bun run typecheck, and full bun test.

## 2026-05-18 W2.S9 Workflow read-only endpoints
- Created `src/server/routes/workflow.ts` with two read-only GET endpoints:
  - `GET /api/projects/:slug/sessions/:sessionId/workflow` — finds the workflow referencing a session via `sessionIds`/`taskSessionIds` reverse lookup, returns 404 if no workflow found
  - `GET /api/projects/:slug/workflows/:workflowId/artifacts/:name` — validates name against `WorkflowArtifactKindSchema`, resolves artifact path (single-file: PRD/SPEC/TASKS/FINAL_REPORT via constant map; multi-file: CRITIC_REPORT/EVIDENCE via workflow state), reads via `WorkflowArtifactManager.read()`, returns raw markdown body
- Added `WorkflowNotFoundError` and `ArtifactNotFoundError` to `src/server/errors.ts`
- Added `WORKFLOW_NOT_FOUND` and `ARTIFACT_NOT_FOUND` to `ServerErrorCode` union
- Wired route via `app.route("/api/projects", workflow)` in `src/server/app.ts`
- Artifact endpoint returns the parsed `body` (after frontmatter extraction), not raw content
- All 15 tests pass covering: session workflow lookup, all 6 artifact kinds, 404 for missing workflow/artifact/session/project, 400 for invalid artifact name
- Lessons learned: `WorkflowArtifactManager.read()` calls `parseFrontmatter()` internally — artifacts must have `---` frontmatter or it throws; always include `frontmatter` in test writes

## 2026-05-18 W2.S11 Graceful shutdown
- Added `src/server/lifecycle.ts` with `setupGracefulShutdown(server, agentRunner, options?)` registering SIGINT/SIGTERM, pushing `shutdown` SSE events with `{ reason: "server_shutdown" }`, aborting all AgentRunner jobs, waiting up to 10s, stopping Bun.serve, and exiting 0/1 on success/timeout.
- Exported `sessionStreams`/`SessionStreamState` from events routes so lifecycle can broadcast to every session ring.
- `AgentRunner.abortAll()` aborts and waits for all currently registered runner instances, which lets boot wiring use the same global shutdown path even though route construction owns its runner.
- Lifecycle tests use injectable process/server/log options to verify signal handler registration, abort/wait/stop/exit ordering, shutdown SSE event payload, and timeout exit behavior.

## 2026-05-18 W3.U6 Attention queue hook
- Added `src/web/src/hooks/use-attention-queue.ts` as the bridge from `pendingPermissions`/`pendingQuestions` maps to sorted arrays and TanStack mutation responders.
- Successful permission/question mutation responses remove pending entries via `createWebSessionStore(sessionId).getState().removePermissionRequest/removeQuestionRequest`; failed mutations leave entries pending.
- Hook unit test mocks `react` hooks directly to avoid the current installed React/react-dom version mismatch (`react` 19.2.5 vs `react-dom` 19.2.6) while still covering the renderHook-style result shape and mutation success callbacks.

## 2026-05-18 W4.V1 Layout shell
- Created `src/web/src/layout/AppLayout.tsx` — BEM-named slots (projectBar, sidebar, chat, detailPanel, header) mapped to CSS grid positions
- Grid CSS lives in `globals.css` (not Tailwind arbitrary classes) because breakpoints are custom (1100px, 800px) and grid-template-columns with responsive overrides are cleaner in plain CSS
- Three-tier component dirs created: `primitives/`, `composite/`, `features/` with `.gitkeep`
- `session.tsx` updated to use AppLayout with placeholder content per slot
- All Tailwind token classes used (bg-bg-surface, border-border-subtle, text-text-secondary, etc.)
- `bun run typecheck` and `bun run web:build` both pass

## 2026-05-18 W4.V2 ProjectBar component
- Created `src/web/src/components/features/ProjectBar.tsx` — renders project icons from `useProjects()` with active state, tooltips, add-project button, and bottom settings/theme icons
- CSS classes for project-bar live in `globals.css` alongside AppLayout grid CSS (same pattern as V1)
- Design spec CSS uses `var(--radius-md)`, `var(--bg-hover)`, etc. — these map to Tailwind tokens via `@theme inline` in globals.css
- Active project uses `.project-item.active` with `::before` pseudo-element for left accent bar (3px, left -8px)
- Tooltip uses opacity 0→1 on hover with `pointer-events: none` and `position: absolute; left: 48px`
- ProjectBar uses `useParams` to determine active slug and `useNavigate` for navigation to `/projects/:slug`
- Integrated into `session.tsx` route (the only route using AppLayout with projectBar slot)
- `project.tsx` and `welcome.tsx` routes don't use AppLayout yet — they'll need integration when their layouts are built

## 2026-05-18 W4.V3 Sidebar component
- Created `src/web/src/components/features/Sidebar.tsx` — renders project name header, search filter, session list grouped by Active/Completed, and agent tree for active session
- CSS classes for sidebar live in `globals.css` following the same pattern as ProjectBar (plain CSS classes matching design spec, not Tailwind utility classes)
- `useSessions(slug)` returns `Session[]` with `id`, `sessionId`, `title`, `createdAt`, `updatedAt`, `lastUpdatedAt`, `subAgentDescriptions`
- `useWorkflow(slug, sessionId)` returns `WorkflowState | null` — but the query function return type is a union `{ workflow?: WorkflowState | null } | WorkflowState | null`, so we cast `workflow as WorkflowState` after null check inside useMemo
- Session activity heuristic: `updatedAt > (Date.now() - 1h)` — simple proxy until server provides explicit status
- Agent tree built from `workflow.sessionIds` and `workflow.taskSessionIds` entries, with depth based on whether it's a stage (depth 1) or task (depth 2)
- Integrated into `session.tsx` replacing the placeholder sidebar slot
- Duplicate function declarations from comment-stripping edits caused TS1005 — fixed by removing duplicates

## 2026-05-18 W4.V6 ChatMessages component
- Created `src/web/src/components/composite/ChatMessages.tsx` with sub-components: `MsgUser`, `MsgAgent`, `ReasoningBlock`, `ToolCard`, `SystemNoticeBlock`, `CompactionBlock`, `PartRenderer`
- All styling uses Tailwind utility classes (no custom CSS classes added to globals.css)
- Auto-scroll: `useRef` for scroll container + sentinel div, `isNearBottom` state (100px threshold), `scrollIntoView({ behavior: 'smooth', block: 'end' })` on sentinel
- Agent avatar colors use Tailwind token classes like `bg-agent-orchestrator/20 text-agent-orchestrator` (opacity modifier on CSS variable colors)
- `animate-spin` is built into Tailwind v4 — no custom `@keyframes spin` needed in globals.css
- Import path from `src/web/src/components/composite/` to `src/store/types.ts` is `../../../../store/types` (4 levels up, not 3)
- `StoredMessage` and `StoredPart` are the internal store types; `SessionMessage` and `SessionPart` are the API types — ChatMessages uses the store types
- `date-fns` not needed — used a simple `formatRelativeTime` function matching Sidebar's pattern
- `subAgentDescriptions` on store is `Map<string, string>` mapping sessionId → description; for now, all assistant messages default to "orchestrator"

## 2026-05-18 W4.V7 DelegationCard component
- Created `src/web/src/components/composite/DelegationCard.tsx` — renders delegation card with agent badge (running/completed/pending), agent name, depth, elapsed time, tool chips, summary text, and "View full conversation →" link
- All styling via Tailwind utility classes (no custom CSS in globals.css)
- AGENT_ICON_COLORS uses Sidebar.tsx hex color pattern (e.g., `bg-[#8b5cf630] text-[#8b5cf6]`) rather than ChatMessages.tsx token pattern (`bg-agent-orchestrator/20 text-agent-orchestrator`) — task explicitly specified Sidebar pattern
- Badge status mapping: running → `bg-success-muted text-success`, completed → `bg-accent-muted text-accent`, pending → `bg-bg-active text-text-muted`
- Tool chip status mapping: success → `text-success` with ✓ prefix, error → `text-error` with ✗ prefix, default → `text-text-tertiary` (no prefix)
- Component accepts all data via props (no internal fetching); navigation uses `useNavigate` with `?focusAgent=<agentId>` query param
- `formatElapsed` computes elapsed time from `startedAt` timestamp (ms)
- `isValidAgentType` guard falls back unknown types to "explorer"
- Design spec CSS `var(--radius-lg)` → Tailwind `rounded-lg`, `var(--radius-sm)` → `rounded-sm`
- Design spec `margin: 10px 0` → `my-2.5` (2.5 * 4px = 10px)
- Design spec `font-size: 10.5px` → `text-[10.5px]`, `font-size: 12.5px` → `text-[12.5px]`
- Design spec `border-radius: 10px` for badge → `rounded-[10px]`
- Design spec `line-height: 1.55` → `leading-[1.55]`
- typecheck and web:build both pass

## 2026-05-18 W4.V9 ChatInput component
- Created `src/web/src/components/features/ChatInput.tsx` — textarea with auto-resize, slash menu, send button, attach button (coming soon), and footer with model name + keyboard hints
- All styling via Tailwind utility classes (no custom CSS in globals.css)
- Auto-resize: `scrollHeight` technique with `min-height: 42px` and `max-height: 200px`, resets to `auto` before recalculating
- Slash menu: appears on `/` input, filters as user types, keyboard navigation (ArrowUp/Down, Enter/Tab to select, Esc to dismiss), positioned `absolute bottom-full` relative to input container
- Only `/compact` command in v1 — `usePostCommand(slug, sessionId, name: "compact")` mutation
- Send button: disabled when textarea empty or mutation pending, uses `usePostMessage(slug, sessionId, content)` mutation
- Enter sends message, Shift+Enter inserts newline, Esc aborts running agent via `usePostCommand(name: "abort")`
- Attach button: shows SVG paperclip icon, toggles "Coming soon" tooltip on click, no actual functionality
- Model name in footer: hardcoded "GLM-5" for v1 (model info not yet in store)
- `isRunning` from `useSessionStore(sessionId, s => s.isRunning)` controls Esc abort visibility
- Integrated into `session.tsx` route replacing chat placeholder
- Slash menu positioned with `relative` on parent container and `absolute bottom-full left-5 right-5` for proper alignment with padding
- Design spec CSS `var(--radius-lg)` → Tailwind `rounded-lg`, `var(--radius-sm)` → `rounded-sm`
- Design spec `font-size: 13.5px` → `text-[13.5px]`, `line-height: 1.55` → `leading-[1.55]`
- Design spec `min-height: 42px` → `min-h-[42px]`, `max-height: 200px` → `max-h-[200px]`
- Design spec `padding: 10px 14px` → `px-3.5 py-2.5` (3.5*4=14, 2.5*4=10)
- Design spec `width: 36px; height: 36px` → `w-9 h-9` (9*4=36)
- Design spec `padding: 12px 20px` → `px-5 py-3` (5*4=20, 3*4=12)

## 2026-05-18 W4.V8 AttentionQueue component
- Created `src/web/src/components/features/AttentionQueue.tsx` with ConfirmationCard, QuestionCard, and QuestionPane sub-components
- All styling via Tailwind utility classes (no custom CSS in globals.css)
- ConfirmationCard: 3 border types — default (border-warning), file_write (border-warning), destructive bash (border-error); destructive bash detection via regex pattern matching on command field
- QuestionCard: tab-based UI for multi-question ask_user requests; single-question cards show inline submit/cancel; multi-question cards show numbered tabs + Confirm tab
- QuestionPane: renders radio (single-select) or checkbox (multi-select) options with custom text input support; custom text submitted via Enter key or Add button
- Confirm tab summarizes all answers before submission; "Submit All Answers" button disabled until all questions answered
- Cards cannot be dismissed without answering — Cancel sends `{ isError: true, reason: "Cancelled by user" }` via `respondQuestion`
- Agent badge colors reuse DelegationCard.tsx hex pattern (e.g., `bg-[#8b5cf630] text-[#8b5cf6]`)
- `useAttentionQueue(sessionId)` hook provides `permissions`, `questions`, `respondPermission`, `respondQuestion`; successful mutations remove pending entries from store
- `QuestionRequest.questions` is typed as `unknown[]` in API types but cast to `QuestionData[]` (matching `AskUserQuestion` schema) in the component
- Design spec CSS `var(--radius-md)` → Tailwind `rounded-md`, `var(--radius-sm)` → `rounded-sm`
- Design spec `border: 1.5px solid` → Tailwind `border-[1.5px]`
- Design spec `accent-subtle` background → `bg-accent-subtle`, `accent-muted` border → `border-accent-muted`
- typecheck and web:build both pass

## W4.V12: TodoTab Component (2025-05-19)

- **StoredTodo has no `priority` field** — only `id`, `content`, `status`, `createdAt?`, `updatedAt?`. Priority badges (P0/P1/P2) are extracted from content text via regex `/\b(P0|P1|P2)\b/i` and stripped from display content.
- **Tailwind v4 theme tokens** map CSS vars to utility classes: `bg-error-muted`, `text-error`, `bg-warning-muted`, `text-warning`, `bg-bg-active`, `text-text-muted`, `bg-success`, `border-accent`, `border-border-strong`, `border-border-subtle`, `text-text-primary`, `text-text-secondary`, `text-text-muted`, `animate-pulse`.
- **Section divider comments** (`// ─── Section Name ───`) are the project convention, matching AttentionQueue.tsx and Sidebar.tsx patterns.
- **useSessionStore(sessionId, selector)** is the hook pattern for accessing store state in web components.
- **Design spec CSS** uses `detail-todo-*` class names; Tailwind equivalents use the theme token system (e.g., `var(--success)` → `bg-success`, `var(--error-muted)` → `bg-error-muted`).
- **in_progress status** uses a pulsing dot (`animate-pulse`) instead of text icon, matching the design spec's border-only circle style.

## 2026-05-19 W4.V10 DetailPanel + DiffTab
- Created `src/web/src/components/features/DetailPanel.tsx` — 3-tab panel (Diff/State/Todo) with tab switching via `useState<TabId>`
- Created `src/web/src/components/features/DiffTab.tsx` — file list + diff content with status badges, line numbers, collapse/expand
- Integrated DetailPanel into `session.tsx` replacing the placeholder detail panel div
- API types: `DiffFile.status` is optional (`"modified" | "created" | "deleted"`), `DiffLine` has `type: "context" | "add" | "delete"` and `content: string` (no `oldLine`/`newLine` fields — line numbers computed from `DiffHunk.oldStart`/`newStart`)
- `useDiff(slug)` returns `UseQueryResult<DiffFile[]>` with 5s polling (configured in queryOptions)
- Design spec CSS mapping: `.diff-badge.modified` → `bg-warning-muted text-warning` (not accent — spec uses `#f59e0b` which is warning/amber), `.diff-badge.created` → `bg-success-muted text-success`, `.diff-badge.deleted` → `bg-error-muted text-error`
- Design spec `.diff-line-add` uses `#22c55e12` bg (success-muted) and `.diff-line-remove` uses `#ef444412` bg (error-muted) — matches Tailwind token classes
- Design spec `.diff-line-num` uses `position: absolute; left: 8px; width: 22px` — converted to flex layout with `w-[48px] shrink-0` columns for old/new line numbers + marker column
- Line number computation: iterate through hunk lines, incrementing `oldStart`/`newStart` based on line type (add increments new only, delete increments old only, context increments both)
- File list uses `shortPath()` to truncate paths >2 segments to `.../last2parts`
- Collapse/expand: `Set<string>` state tracking collapsed file paths, toggle via header click
- Responsive: `md:flex-row` for side-by-side layout, stacked on mobile with file list on top
- All Tailwind utility classes, no custom CSS added to globals.css
- typecheck and web:build both pass

## 2026-05-19 W4.V11 StateTab component
- Created `src/web/src/components/features/StateTab.tsx` — renders workflow status, active agents list, and artifacts section (PRD/SPEC/TASKS with status badges)
- Uses `PipelineStepper` (already built) for the pipeline visualization at the top
- Workflow info section shows ID, status (color-coded), stage (human-readable labels via STAGE_LABELS map), attempt count, and creation time
- Active agents section built from `workflow.sessionIds` and `workflow.taskSessionIds` — same pattern as Sidebar.tsx agent tree
- Artifact status inferred from workflow stage progression: missing (no path in artifacts), draft (path exists but stage hasn't progressed past), finalized (stage has moved past the artifact's creation stage)
- Artifact click opens an overlay drawer (`absolute inset-0 z-10`) showing markdown content via `<pre className="whitespace-pre-wrap break-words">` — no react-markdown dependency
- Artifact content fetched via `useArtifactContent` hook using `useQuery` with endpoint `/api/projects/:slug/workflows/:workflowId/artifacts/:name` returning `{ body: string }`
- Design spec CSS `.workflow-state-*` classes mapped to Tailwind: `.workflow-state-block` → `mb-3.5`, `.workflow-state-label` → `text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5`, `.workflow-state-card` → `p-2.5 bg-bg-elevated border border-border-default rounded-md`, `.workflow-state-row` → `flex items-center justify-between py-1 text-xs border-t border-border-subtle first:border-t-0`
- Design spec `.workflow-state-value.active` → `text-success`, `.workflow-state-value.pending` → `text-text-muted`
- Design spec `.state-artifact-status.missing` → `bg-bg-active text-text-muted`, `.state-artifact-status.draft` → `bg-warning-muted text-warning`, `.state-artifact-status.finalized` → `bg-success-muted text-success`
- Agent colors use Tailwind token classes (`text-agent-orchestrator`, etc.) matching the CSS variable pattern in globals.css
- `WorkflowState` from API types has `artifacts?: Record<string, string | string[] | undefined>` — artifact values are paths, not status objects; status must be inferred from stage progression
- `WorkflowArtifactKindSchema` values: PRD, SPEC, TASKS, CRITIC_REPORT, EVIDENCE, FINAL_REPORT — only PRD/SPEC/TASKS shown in the UI
- Drawer uses `absolute inset-0 z-10` positioning within the `relative` parent container for overlay effect
- typecheck and web:build both pass

## 2026-05-19 W4.V14 Theme toggle hook
- Created `src/web/src/hooks/use-theme.ts` — `useTheme()` returns `{ theme: 'light' | 'dark', toggleTheme }` with localStorage persistence under key `specraTheme`
- On mount: reads `localStorage.specraTheme`, falls back to `window.matchMedia('(prefers-color-scheme: dark)')`, applies via `document.documentElement.setAttribute('data-theme', theme)`
- `toggleTheme()` flips theme, saves to localStorage, applies `data-theme` attribute
- Cross-tab sync via `window.addEventListener('storage', ...)` — when another tab changes specraTheme, the hook updates state and reapplies
- `useEffect` for mount-only apply uses empty deps `[]` — subsequent changes handled by toggleTheme calling `applyTheme()` directly (not via effect)
- ProjectBar updated to show ☀ in dark mode, 🌙 in light mode, wired to `toggleTheme()`
- globals.css already had `:root` (dark) and `[data-theme="light"]` blocks — no CSS changes needed
- typecheck ✅, web:build ✅

## W4.V13: AddProjectModal component

- Created `src/web/src/components/features/AddProjectModal.tsx` — modal with workspace path input + optional name override, submit calls `useAddProject()` mutation, on success navigates to `/projects/:slug`
- Modal pattern: `open`/`onClose` props, `useRef` for overlay click-outside detection, `useEffect` for Escape key, form reset on open
- `useAddProject()` mutation updated to accept `{ path: string; name?: string }` — server API accepts both `workspaceRoot` and `name` in POST body
- ProjectBar updated with `onAddProject?: () => void` prop (replacing `console.log` stub); `useTheme` import added (was missing, causing pre-existing typecheck error)
- session.tsx wires `useState<boolean>(false)` for modal open/close, passes `onAddProject` callback to ProjectBar, renders `<AddProjectModal>` as sibling of `<AppLayout>` (outside grid, uses `fixed inset-0 z-50`)
- Design spec CSS mapping: `.modal-overlay` → `fixed inset-0 z-50 flex items-center justify-center bg-black/50`, `.modal` → `w-[min(480px,90vw)] max-h-[80vh] overflow-y-auto rounded-lg border border-border-default bg-bg-surface shadow-lg`, `.modal-header` → `flex items-center justify-between border-b border-border-subtle px-5 py-4`, `.modal-title` → `text-base font-semibold text-text-primary`, `.modal-close` → `flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-secondary`, `.modal-body` → `p-5`, `.modal-input` → `w-full rounded-sm border border-border-default bg-bg-base px-3 py-2.5 text-[13.5px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none`, `.modal-label` → `mb-1.5 block text-xs font-medium text-text-secondary`, `.modal-error` → `text-xs text-error`, `.modal-actions` → `flex justify-end gap-2 border-t border-border-subtle px-5 py-3`, `.btn-primary` → `rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40`, `.btn-secondary` → `rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary hover:bg-bg-hover`
- All Tailwind utility classes, no custom CSS added to globals.css
- typecheck and web:build both pass
