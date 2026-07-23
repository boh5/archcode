# Changelog

All notable changes to ArchCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
