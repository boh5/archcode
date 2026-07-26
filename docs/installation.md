# Installation and platform support

The fastest way to install ArchCode is the installer published with every
GitHub Release:

```sh
curl -fsSL https://github.com/boh5/archcode/releases/latest/download/install.sh | sh
```

The installer:

- detects macOS or Linux and arm64 or x64;
- downloads the matching versioned archive;
- verifies it against `SHA256SUMS`;
- checks the extracted binary version;
- installs `archcode` to `~/.local/bin` without `sudo`.

It does not edit `~/.archcode`, modify your shell, create a background service,
or change authentication. If `~/.local/bin` is not on `PATH`, it prints the
exact export to add.

## Supported platforms

| System | Architecture | Release asset |
|---|---|---|
| macOS 13 or newer | Apple silicon (arm64) | `archcode-macos-arm64-vVERSION.tar.gz` |
| macOS 13 or newer | Intel (x64) | `archcode-macos-x64-vVERSION.tar.gz` |
| Linux with glibc 2.17 or newer | arm64 | `archcode-linux-arm64-vVERSION.tar.gz` |
| Linux with glibc 2.17 or newer | x64 | `archcode-linux-x64-vVERSION.tar.gz` |
| Windows 10/11 | WSL2 | The Linux archive matching the WSL architecture |

Native Windows execution is not supported in the current release.

## Installer options

Select a release or installation prefix:

```sh
curl -fsSL https://github.com/boh5/archcode/releases/latest/download/install.sh \
  | sh -s -- --version 0.0.3 --prefix "$HOME/.local"
```

Use `--dry-run` to inspect the resolved platform, asset, and destination
without downloading or changing files.

## Manual verification and installation

Every Release contains versioned archives, `SHA256SUMS`, and a
`release-manifest.json` with archive and embedded-binary digests. For example,
to install the Apple silicon archive manually:

```sh
version=0.0.3
asset="archcode-macos-arm64-v${version}.tar.gz"
curl -fLO "https://github.com/boh5/archcode/releases/download/v${version}/${asset}"
curl -fLO "https://github.com/boh5/archcode/releases/download/v${version}/SHA256SUMS"
grep "  ${asset}$" SHA256SUMS | shasum -a 256 -c -
tar -xzf "$asset"
mkdir -p "$HOME/.local/bin"
install -m 755 archcode "$HOME/.local/bin/archcode"
"$HOME/.local/bin/archcode" --version
```

Linux users can replace `shasum -a 256` with `sha256sum`.

## macOS signing

The macOS binary is a command-line server, not an app bundle, and is not
currently signed or notarized. The installer downloads it with `curl`, verifies
the official checksum, and extracts it in the terminal. It does not bypass
Gatekeeper or remove quarantine attributes.

## Windows through WSL2

Run ArchCode inside WSL2 and keep registered repositories in the WSL Linux
filesystem for reliable permissions and filesystem performance. Configuration
lives at `~/.archcode/config.json` inside WSL, while a Windows browser can open
`http://localhost:4096`.

## First run

Start ArchCode:

```sh
archcode
```

When `~/.archcode/config.json` is missing, the server prints a one-time Setup
URL. Open it to configure the first Provider, Model, the three required
Profiles, and an optional password. ArchCode activates the workbench on the
same port without restarting.

If an existing Config is invalid, ArchCode reports the error without
overwriting the file or reopening Setup.

## Uninstalling the executable

If you used the default prefix, remove the installed binary:

```sh
rm "$HOME/.local/bin/archcode"
```

This does not remove `~/.archcode` or project-local `.archcode/runtime` state.
Review those directories separately before deleting data.

For network access and long-running process guidance, continue with
[local and remote deployment](deployment.md).
