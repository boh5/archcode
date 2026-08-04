# Settings Page Overrides

This file defines Settings-only behavior. All visual language, semantic tokens,
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
Models, Profiles, Security, Runtime Data, MCP, Memory, GitHub, and About &
Updates reachable. About & Updates retains its existing panel, behavior, and
copy and never suggests that updating preserves, repairs, or makes Runtime data
compatible.

## Config Recovery

- An invalid global Config must not stop the HTTP server or Web shell. The
  terminal prints a process-local `/config-recovery#token=...` URL; without
  that grant, the Web UI explains how to reopen the terminal URL and exposes
  no diagnostics or mutation.
- The recovery shell uses the ordinary Settings sidebar. `Config Recovery` and
  `About & Updates` are enabled; Models, Profiles, Security, Runtime Data, MCP,
  Memory, and GitHub remain visible but disabled with the explanation
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
- MCP configuration remains editable from Config. Live discovery status shows
  `Unavailable while Runtime is offline` instead of failing the Settings
  workspace or implying that an MCP server itself failed.
- Security and About & Updates preserve their existing independent behavior.

## Layout And Accessibility

- Desktop uses the existing 208px Settings navigation and scrolling content
  column. The full-page recovery workspace is centered within the available
  viewport but uses the full height required for safe action placement.
- At narrow widths the navigation becomes the existing compact grid above the
  content. Project identity, Runtime paths, issue text, and confirmation content
  wrap; the document never scrolls horizontally.
- Keep the action footer in normal flex layout with wrapping. It must remain
  reachable at 390, 760, 1024, and 1440px and must not cover content.
- Use semantic headings, lists, labels, native checkboxes and buttons. The
  selected state is announced by the checkbox; disabled healthy projects expose
  a textual explanation.
- All controls retain visible focus rings and at least 44px hit areas on coarse
  pointers. Dialog Escape and Cancel remain available until deletion begins.
- Light and dark modes use existing semantic tokens. No page-local colors,
  decorative animation, or new prototype are introduced.
