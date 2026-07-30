# Changelog

All notable changes to ArchCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.7] - 2026-07-30

### Changed

- Split model and variant selection into separate searchable controls so
  defaults, active overrides, and available variants are easier to distinguish.
- Keep workbench navigation and inspector controls available across Dashboard,
  Todo, Automation, and Session pages, replacing the separate Focus Mode
  setting with direct panel controls.
- Present model input and output modalities as explicit text, image, audio, and
  video selections while keeping Settings notices and actions reachable.
- Consolidate the active design baseline, page-specific guidance, and current
  HTML prototypes under `design-system/` without changing Runtime behavior.

### Fixed

- Fall back to a model's default configuration when a saved Profile references
  a removed variant, and normalize empty variant maps to the Default choice.
- Surface specific configuration validation failures in Settings instead of
  replacing them with a generic save error.

## [0.0.6] - 2026-07-29

### Added

- Add durable Session attachments with guarded upload, model projection, and
  composer support.
- Stream live Bash output into the workbench while preserving bounded,
  redacted tool results.
- Add execution navigation and sortable Project Todo workflows for moving
  between parallel work and entering multiple Sessions.
- Add safe Session and Automation deletion with active-run shutdown,
  Automation reference protection, and cross-tab cleanup.

### Changed

- Unify suspend, resume, steer, approval, and terminal handling under one
  logical Execution lifecycle.
- Preserve persisted message phases when projecting model workstreams so
  commentary, reasoning, tools, and final output retain their real order.
- Refine the Session composer, navigation, dashboard, and work activity
  presentation for denser engineering workflows.

### Fixed

- Restore live Execution state from authoritative Session snapshots after
  reconnecting or refreshing.
- Stabilize streaming work presentation and temporal text updates during
  long-running executions.
- Require the one-time setup token before exposing the first-run setup form.
- Preserve structured tool payloads while keeping secret redaction at the
  finalized output boundary.

## [0.0.5] - 2026-07-27

### Changed

- Publish a follow-up signed release for validating installer-managed direct
  updates from v0.0.4.

## [0.0.4] - 2026-07-27

### Added

- Add strict `ARCHCODE_LOG_LEVEL` and `ARCHCODE_ACCESS_LOG` controls while
  preserving HTTP access status semantics in the shared structured logger.
- Add installer-managed direct updates in **Settings → About & Updates** and
  through `archcode update`, with live progress and idle-only restart.
- Publish an offline Sigstore attestation bundle and verify the exact official
  release workflow, tag, manifest, archive, and embedded binary before install.

### Changed

- Make the Release installer write a binary-bound management receipt required
  for direct updates. Existing installations must run the installer once to
  enter the managed update path.
- Simplify Goal creation and completion by moving confirmation and review
  interpretation into the Lead workflow instead of rigid Runtime protocols.

## [0.0.3] - 2026-07-24

### Added

- Add `--port` / `-p` startup options with strict validation and precedence over
  `ARCHCODE_PORT`.
- Publish an immutable `install.sh` Release asset that verifies and atomically
  installs the matching archive without `sudo` or configuration changes.

### Changed

- Package macOS/Linux release executables as versioned `.tar.gz` assets
  with a stable inner `archcode` filename.
- Fail startup with an actionable error when the selected port is occupied
  instead of silently switching to a random port.
- Record both archive and embedded binary digests in the Release manifest.

## [0.0.2] - 2026-07-24

### Changed

- Publish four standalone executables with user-facing macOS/Linux and arm64/x64
  names that include the release version.
- Replace target-triple `.tar.gz` Release assets with binaries that can be
  downloaded and run directly after granting execute permission.
- Retain SHA-256 checksums, the machine-readable release manifest, provenance
  attestations, and isolated startup tests for every supported build.

## [0.0.1] - 2026-07-24

Initial public preview of the ArchCode always-on workbench.

### Highlights

- Run the Hono server and React workbench as one self-contained executable.
- Manage multiple projects, long-running Sessions, Todos, optional Session Goals,
  Automations, approvals, questions, memory, and structured tool output.
- Coordinate five Agent identities through the `principal`, `deep`, and `fast`
  model Profiles.
- Download native macOS and Linux builds for arm64 and x64 from GitHub Releases.
- Run the Linux build on Windows through WSL2.

### Known limitations

- Native Windows executables are not supported. Windows users must use WSL2.
- The first macOS release is not code-signed or notarized. Verify `SHA256SUMS`
  before explicitly allowing the downloaded executable in macOS.
- ArchCode requires a user-supplied `~/.archcode/config.json` with model
  Provider and Profile configuration.
