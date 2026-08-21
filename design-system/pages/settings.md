# Settings Surface Overrides

This file defines Settings-only behavior across its dialog and recovery
presentations. All visual language, semantic tokens,
motion, typography, and accessibility rules continue to come from
[`../MASTER.md`](../MASTER.md).

## Product Role

Settings is one shared workspace with three presentations:

- while Runtime is ready, it opens in the existing bounded dialog;
- while Runtime activation has failed, the same workspace fills the page and
  opens on `Runtime Data` after authentication.
- while the global Config is invalid, a terminal-grant-protected full-page
  Settings shell opens on `Config Recovery`.

The recovery presentation is not a separate error page. Its navigation keeps
Models, Profiles, Security, Runtime Data, MCP, Skills, Memory, GitHub, and About &
Updates reachable. About & Updates retains its existing panel, behavior, and
copy and never suggests that updating preserves, repairs, or makes Runtime data
compatible.

Every visible Settings navigation item is an operable section selector. A
prototype must project the selected heading, the section's real control family,
and representative state transitions; never leave visible sidebar items inert,
reduce an editable section to decorative status rows, or keep Models content
under another selected section.

## Ready Runtime Dialog

- Settings is a global modal surface, not a route. The rail trigger opens one
  bounded `960 × 600px` desktop dialog on `Models`; Escape, the close button,
  and backdrop dismissal return focus to that trigger.
- Keep one compact 172px navigation rail and one independently scrolling
  content column. The navigation order is Models, Profiles, Security, Runtime
  Data, MCP, Skills, Memory, GitHub, and About & Updates.
- Models exposes Provider ID/name/package/options, preserved-secret handling,
  Model identity/limits/modalities, `Default options JSON`, `Variants JSON`, and
  add/remove actions. `Variants JSON` is a free-form object whose keys are
  Variant names and whose values are Model-call option objects; never replace it
  with fixed `fast` / `deep` chips or a hard-coded Variant catalog.
- Profiles exposes the required principal/deep/fast bindings. Each Profile has
  a Model selector, a Variant selector containing `Default` plus only the keys
  defined by that selected Model, and an independent `Overrides JSON` layer.
  Changing Model clears the Profile Variant. A removed Variant remains visible
  as attention, may still be saved, and resolves through the Model default until
  the reference is repaired; it is not a whole-Config validation failure.
- Models, Profiles, MCP, Memory configuration, and GitHub share one global
  dirty-state footer. It distinguishes `All changes saved`, `Unsaved changes`,
  invalid input, reloading, and saving; Reload restores the latest server
  snapshot. Save reports model/Profile live apply, MCP apply failure separately,
  Runtime-unavailable persistence, and restart-required sections accurately.
- Security owns its password request lifecycle independently. It shows current,
  new, and confirmation fields as applicable, enforces the 10-character / 1024
  UTF-8-byte contract, and supports enable, change, and remove actions. Changing
  or removing the password states that existing browser sessions are signed
  out. The shared Config footer does not pretend to submit password fields.
- Security also exposes one Config-backed `AI approval review` toggle. Its
  default is enabled when `permissions.autoReview` is absent, and its helper
  copy states that the fast model only approves one action when it clearly fits
  the current task; uncertainty or failure still asks the user. The toggle
  participates in the shared Config draft, dirty state, Save, Reload, revision
  conflict, and feedback behavior; it does not add a permission mode or model
  selector.
- While the Config draft is dirty, password mutation actions are disabled and
  the Security section tells the user to Save or Reload first. Password fields
  and their independent request/error lifecycle remain separate from Config
  persistence, and saving the Config never submits password values.
- While a password mutation request is pending, lock Settings section
  navigation, Config controls, Save, and Reload. This prevents a successful
  password request and its authoritative reload from discarding a newer Config
  draft created during the request.
- Runtime Data is an independent inspection and recovery workflow. Project
  selection enables the destructive action; Retry Runtime is secondary; Delete
  opens the exact irreversible confirmation described below. It never uses the
  Config Save footer.
- MCP keeps definition fields, enabled state, live status, Test draft,
  Reconnect, discovered tools, and add/remove actions together. Reconnect is
  available only for an enabled, saved definition; draft and live outcomes are
  never collapsed into one success message.
- Skills is project-scoped and read-only. It exposes winning, shadowed, invalid,
  source-tier, Prompt-included, and Prompt-omitted facts without enable/disable
  controls or implied permission changes.
- Memory combines global `Use Memory` / `Auto learning` configuration with
  independent project Personal Memory and knowledge-topic editors. Explicit
  Memory saves, revision conflicts, reload, clear, and topic delete remain
  separate from the Config footer and use confirmation where destructive.
- GitHub exposes enabled state, token environment-variable name, default owner,
  and default repository. About & Updates exposes installed build, management
  state, channel, integrity, Check, Install, and Restart phases; Updates is
  independent and never uses the Config footer.
- A visual prototype may simulate server responses locally, but every visible
  action must update its projected state, validation, confirmation, or feedback.
  Do not show inert controls or success toasts that leave the represented state
  unchanged.

## Config Recovery

- An invalid global Config must not stop the HTTP server or Web shell. The
  terminal prints a process-local `/config-recovery#token=...` URL; without
  that grant, the Web UI explains how to reopen the terminal URL and exposes
  no diagnostics or mutation.
- The recovery shell uses the ordinary Settings sidebar. `Config Recovery` and
  `About & Updates` are enabled; Models, Profiles, Security, Runtime Data, MCP,
  Skills, Memory, and GitHub remain visible but disabled with the explanation
  `Unavailable until the global configuration is valid`.
- Show only the canonical Config path, server-produced safe structural
  diagnostics, and server-offered bounded invalid-item choices. Choice IDs are
  opaque; labels, structural paths, and impact text never expose Config record
  keys, raw invalid values, credentials, or a browser Config editor.
- `Preserve valid settings` is the primary destructive recovery path. Every
  checkbox starts unselected. Its confirmation lists the selected invalid
  entries, says their deletion is permanent, and explains that the server
  writes only when the complete remaining Config passes current validation.
  A failed candidate validation changes no bytes.
- `Retry configuration` rereads the file in the same process. If valid, apply
  authentication and continue to Runtime activation; if missing, continue to
  Setup with the same terminal grant; if still invalid, retain the page and
  refresh the safe diagnostics.
- Put `Reset entire Config` in a visually separated, collapsed last-resort
  region. Its dialog warns that valid Providers, Models, Profiles, MCP, Memory,
  GitHub, and login/security settings will be lost, while project source, Git,
  and project Runtime data remain. Confirmation requires typing exact `RESET`;
  success opens the existing Setup UI with the same process-local grant.
- Retry and Reset errors remain inline. Move focus to the `Config Recovery`
  heading after a failed action; use a polite status for a completed invalid
  retry and an alert for request failures.
- Do not select entries automatically or guess replacements. Do not add
  migration, backup, restore, legacy readers, an upgrade recommendation, or a
  second Config format.

## Runtime Data

- Place `Runtime Data` in the existing `Server` navigation group.
- Show the current Runtime state and its safe startup error summary in a
  distinct status region. Data inspection results appear below it and must not
  be described as the cause of the startup error.
- Each project row shows project name, workspace, Runtime directory, file count,
  byte size, and every detected relative file issue with a textual reason.
- All project checkboxes start unselected. A project without a current detected
  issue is disabled and cannot be selected.
- `Retry Runtime` is a secondary action. `Delete runtime data` is the only
  visually primary destructive action and remains disabled until at least one
  eligible project is selected.
- Inspection loading, empty, failed, delete-pending, per-project delete failure,
  retry-pending, retry-success, and retry-failure states remain in context and
  use text or an icon in addition to color.

## Irreversible Delete Confirmation

The confirmation dialog lists every selected project and exact Runtime
directory. It states that deletion permanently removes Sessions, Todos,
Automations, HITL requests, permissions, attachments, and project memory. It
also states that source files, `.git`, `.archcode/plans`, `.archcode/skills`,
project registration, and `~/.archcode/config.json` remain.

Deletion is irreversible. Do not offer Undo, backup, migration, file-level
repair, or arbitrary-path controls. Cancel sends no request. Confirm disables
both actions while pending and prevents duplicate submission. On completion,
move focus to the Runtime Data status heading and announce the result through a
polite live region; destructive and request errors use an alert.

## Runtime-Unavailable Section Behavior

- Config-backed sections use the control-plane Config API. Saving while Runtime
  is unavailable says only that the configuration was saved and directs the
  user to `Retry Runtime`; it never says changes were applied live.
- Runtime Data and About & Updates do not wait for Config or MCP data before
  rendering.
- MCP configuration remains editable from Config. Each server draft uses the
  required transport `type` (`http` or `stdio`) and `enabled` fields; built-in
  opt-out is controlled by `disabledBuiltins`. When Runtime is ready, saving
  hot-applies the draft and each server exposes live `disabled`, `connecting`,
  `ready`, or `failed` status plus discovered tool inventory, **Test**, and
  **Reconnect** actions. If Runtime is offline, show `Unavailable while
  Runtime is offline` instead of failing the Settings workspace or implying
  that an MCP server itself failed. Config persistence and live MCP apply are
  separate outcomes and must be reported separately.
- Skills is a project-scoped, read-only diagnostic surface. It shows every
  candidate across the five precedence tiers, the winning/shadowed/invalid
  state and safe diagnostic, plus the canonical Prompt directory preview,
  included/omitted counts, and byte size. It has no enable/disable controls.
  Outside a project it says to open a project instead of guessing a workspace.
- Security and About & Updates preserve their existing independent behavior.

## Layout And Accessibility

- Desktop uses a bounded 960 × 600px dialog, the current prototype's compact
  172px Settings navigation, and one scrolling content column. The full-page
  recovery workspace is centered within the available viewport but uses the
  full height required for safe action placement.
- Match the current dense type hierarchy: navigation/control labels and editor
  identities are 11.5px, while tertiary helper copy, section metadata, and
  status explanations may use 10.5px. Editable values and primary content keep
  their component-appropriate larger size; do not use the micro role for user
  input or long-form diagnostic prose.
- At `≤640px` the navigation becomes the existing three-column compact grid
  above the content. Project identity, Runtime paths, MCP tool identities, Skill names,
  diagnostics, and confirmation content wrap; the document never scrolls
  horizontally.
- Keep the action footer in normal flex layout with wrapping. It must remain
  reachable at 390, 640, 1024, and 1440px and must not cover content.
- Use semantic headings, lists, labels, native checkboxes and buttons. The
  selected state is announced by the checkbox; disabled healthy projects expose
  a textual explanation.
- All controls retain visible focus rings and at least 44px hit areas on coarse
  pointers. Dialog Escape and Cancel remain available until deletion begins.
- Light and dark modes use existing semantic tokens. No page-local colors,
  decorative animation, or additional parallel prototype are introduced. The
  current Settings visual reference is `../prototypes/settings.html`; it keeps
  the existing bounded dialog, rail, section navigation, shared Config footer,
  and Security states described above.
